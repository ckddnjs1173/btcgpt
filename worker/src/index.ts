import { z } from 'zod';
import {
  calculatePositionPlan,
  signedFundingPayment,
  validateRiskQuantity,
} from '../../src/shared/calculations/costs';

const MAX_BODY_BYTES = 90_000;
const MAX_SNAPSHOT_BYTES = 89_000;
const MAX_SNAPSHOT_AGE_MS = 15_000;
const FUTURE_TOLERANCE_MS = 5_000;

interface D1Result {
  success: boolean;
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<D1Result>;
  first<T>(): Promise<T | null>;
}
interface D1Database {
  prepare(query: string): D1Statement;
}
export interface Env {
  DB?: D1Database;
  UPLOADER_WRITE_KEY: string;
  ACTION_READ_KEY: string;
}

const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: z.string().min(1).max(100),
    symbol: z.literal('BTCUSDT'),
    market: z.literal('BINANCE_USDM_PERPETUAL'),
    generatedAt: z.number().int().positive(),
    analysisGate: z
      .object({
        analysisAllowed: z.boolean(),
        overallStatus: z.enum([
          'INITIALIZING',
          'NORMAL',
          'DELAYED',
          'STALE',
          'DISCONNECTED',
          'INSUFFICIENT_DATA',
        ]),
      })
      .passthrough(),
  })
  .passthrough();

const planSchema = z.object({
  side: z.enum(['LONG', 'SHORT']),
  entry: z.number().positive(),
  stop: z.number().positive(),
  targets: z.array(z.number().positive()).min(1).max(3),
  maxLossUsdt: z.number().positive().optional(),
  accountEquity: z.number().positive().optional(),
  riskPercent: z.number().positive().max(1).optional(),
  entryOrderType: z.enum(['MAKER', 'TAKER']).default('TAKER'),
  exitOrderType: z.enum(['MAKER', 'TAKER']).default('TAKER'),
  expectedFundingPeriods: z.number().int().min(0).max(12).default(0),
  leverage: z.literal(10),
  marginMode: z.literal('ISOLATED'),
});

let memorySnapshot: {
  raw: string;
  generatedAt: number;
  receivedAt: number;
} | null = null;
const rateBuckets = new Map<string, { startedAt: number; count: number }>();
const FORBIDDEN_SNAPSHOT_KEYS = new Set([
  'apikey',
  'apisecret',
  'secret',
  'signature',
  'authorization',
  'accountid',
  'orderid',
  'clientorderid',
]);

function containsForbiddenSnapshotKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenSnapshotKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      FORBIDDEN_SNAPSHOT_KEYS.has(key.toLowerCase()) ||
      containsForbiddenSnapshotKey(nested),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function bearer(request: Request): string | null {
  const value = request.headers.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}

function authorized(request: Request, expected: string): boolean {
  const actual = bearer(request);
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function rateLimited(request: Request): boolean {
  const key = request.headers.get('cf-connecting-ip') ?? 'local';
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= 60_000) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    if (rateBuckets.size > 10_000)
      for (const [candidate, state] of rateBuckets)
        if (now - state.startedAt >= 60_000) rateBuckets.delete(candidate);
    return false;
  }
  bucket.count += 1;
  return bucket.count > 120;
}

async function save(env: Env, raw: string, generatedAt: number): Promise<void> {
  const receivedAt = Date.now();
  if (env.DB) {
    await env.DB.prepare(
      `
      INSERT INTO latest_snapshot (id, payload, generated_at, received_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,
        generated_at=excluded.generated_at, received_at=excluded.received_at
    `,
    )
      .bind(raw, generatedAt, receivedAt)
      .run();
    return;
  }
  memorySnapshot = { raw, generatedAt, receivedAt };
}

async function load(env: Env) {
  if (env.DB) {
    return env.DB.prepare(
      'SELECT payload AS raw, generated_at AS generatedAt, received_at AS receivedAt FROM latest_snapshot WHERE id = 1',
    ).first<{ raw: string; generatedAt: number; receivedAt: number }>();
  }
  return memorySnapshot;
}

export async function handler(request: Request, env: Env): Promise<Response> {
  if (rateLimited(request)) return json({ error: 'RATE_LIMITED' }, 429);
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true });
  }

  if (url.pathname === '/v1/snapshot/latest' && request.method === 'PUT') {
    if (!authorized(request, env.UPLOADER_WRITE_KEY))
      return json({ error: 'UNAUTHORIZED' }, 401);
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES)
      return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES)
      return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    if (new TextEncoder().encode(raw).byteLength > MAX_SNAPSHOT_BYTES)
      return json({ error: 'SNAPSHOT_RESPONSE_BUDGET_EXCEEDED' }, 413);
    let parsed: z.infer<typeof snapshotSchema>;
    try {
      const candidate = JSON.parse(raw) as unknown;
      if (containsForbiddenSnapshotKey(candidate))
        return json({ error: 'FORBIDDEN_SNAPSHOT_FIELD' }, 400);
      parsed = snapshotSchema.parse(candidate);
    } catch {
      return json({ error: 'INVALID_SNAPSHOT' }, 400);
    }
    const now = Date.now();
    if (parsed.generatedAt > now + FUTURE_TOLERANCE_MS)
      return json({ error: 'FUTURE_SNAPSHOT' }, 400);
    await save(env, raw, parsed.generatedAt);
    return json({ ok: true, receivedAt: now });
  }

  if (url.pathname === '/v1/snapshot/latest' && request.method === 'GET') {
    if (!authorized(request, env.ACTION_READ_KEY))
      return json({ error: 'UNAUTHORIZED' }, 401);
    const stored = await load(env);
    if (!stored) return json({ error: 'NOT_FOUND' }, 404);
    const ageMs = Date.now() - stored.generatedAt;
    const payload = JSON.parse(stored.raw) as Record<string, unknown>;
    const originalGate = payload.analysisGate as Record<string, unknown>;
    payload.analysisGate = {
      ...originalGate,
      ageMs,
      publishedAt: stored.receivedAt,
    };
    if (ageMs > MAX_SNAPSHOT_AGE_MS) {
      payload.analysisGate = {
        ...(payload.analysisGate as Record<string, unknown>),
        analysisAllowed: false,
        overallStatus: 'STALE',
        ageMs,
        reasons: [
          ...((originalGate.reasons as string[] | undefined) ?? []),
          'RELAY_SNAPSHOT_STALE',
        ],
      };
    }
    const responseBody = { ...payload, relayReceivedAt: stored.receivedAt };
    if (
      new TextEncoder().encode(JSON.stringify(responseBody)).byteLength >
      MAX_BODY_BYTES
    )
      return json({ error: 'RESPONSE_TOO_LARGE' }, 500);
    return json(responseBody);
  }

  if (url.pathname === '/v1/plan/validate' && request.method === 'POST') {
    if (!authorized(request, env.ACTION_READ_KEY))
      return json({ error: 'UNAUTHORIZED' }, 401);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 10_000)
      return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    let requestBody: unknown;
    try {
      requestBody = JSON.parse(raw) as unknown;
    } catch {
      return json({ ok: false, errors: ['INVALID_JSON'] }, 400);
    }
    const parsed = planSchema.safeParse(requestBody);
    if (!parsed.success)
      return json(
        {
          ok: false,
          errors: parsed.error.issues.map((issue) => issue.message),
        },
        400,
      );
    const plan = parsed.data;
    const errors: string[] = [];
    if (plan.side === 'LONG' && plan.stop >= plan.entry)
      errors.push('LONG_STOP_MUST_BE_BELOW_ENTRY');
    if (plan.side === 'SHORT' && plan.stop <= plan.entry)
      errors.push('SHORT_STOP_MUST_BE_ABOVE_ENTRY');
    if (
      plan.targets.some((target) =>
        plan.side === 'LONG' ? target <= plan.entry : target >= plan.entry,
      )
    )
      errors.push('TARGET_MUST_BE_PROFITABLE_BEFORE_COSTS');
    const stored = await load(env);
    if (!stored)
      return json({ ok: false, errors: ['SNAPSHOT_NOT_FOUND'] }, 409);
    if (Date.now() - stored.generatedAt > MAX_SNAPSHOT_AGE_MS)
      return json({ ok: false, errors: ['SNAPSHOT_STALE'] }, 409);
    const snapshot = JSON.parse(stored.raw) as {
      analysisGate?: { analysisAllowed?: boolean };
      marketState?: { fundingRate?: number | null };
      productFilters?: {
        tickSize?: number;
        stepSize?: number;
        minQuantity?: number;
        minNotional?: number;
      } | null;
      costSettings?: {
        makerFeeRate?: number | null;
        takerFeeRate?: number | null;
        entrySlippageBps?: number | null;
        exitSlippageBps?: number | null;
      };
      account?: { availableBalance?: number | null };
    };
    if (snapshot.analysisGate?.analysisAllowed !== true)
      return json({ ok: false, errors: ['ANALYSIS_NOT_ALLOWED'] }, 409);
    const filters = snapshot.productFilters;
    if (
      !filters?.tickSize ||
      !filters.stepSize ||
      !filters.minQuantity ||
      !filters.minNotional
    )
      return json({ ok: false, errors: ['PRODUCT_FILTERS_MISSING'] }, 409);
    const maker = snapshot.costSettings?.makerFeeRate;
    const taker = snapshot.costSettings?.takerFeeRate;
    const entryFeeRate = plan.entryOrderType === 'MAKER' ? maker : taker;
    const exitFeeRate = plan.exitOrderType === 'MAKER' ? maker : taker;
    if (entryFeeRate === null || entryFeeRate === undefined)
      errors.push('ENTRY_FEE_RATE_REQUIRED');
    if (exitFeeRate === null || exitFeeRate === undefined)
      errors.push('EXIT_FEE_RATE_REQUIRED');
    const entrySlippageRate =
      (snapshot.costSettings?.entrySlippageBps ?? 0) / 10_000;
    const exitSlippageRate =
      (snapshot.costSettings?.exitSlippageBps ?? 0) / 10_000;
    const quantityResult = validateRiskQuantity({
      entry: plan.entry,
      stop: plan.stop,
      maxLossUsdt: plan.maxLossUsdt,
      accountEquity: plan.accountEquity,
      riskPercent: plan.riskPercent,
      availableMargin: snapshot.account?.availableBalance,
      entryFeeRate: entryFeeRate ?? 0,
      exitFeeRate: exitFeeRate ?? 0,
      slippageRate: Math.max(entrySlippageRate, exitSlippageRate),
      stepSize: filters.stepSize,
      minQuantity: filters.minQuantity,
      minNotional: filters.minNotional,
      tickSize: filters.tickSize,
    });
    errors.push(...quantityResult.reasons);
    const quantity = quantityResult.quantity;
    const fundingRate =
      (snapshot.marketState?.fundingRate ?? 0) * plan.expectedFundingPeriods;
    const targets =
      quantity > 0
        ? plan.targets.map((target) => ({
            target,
            ...calculatePositionPlan({
              side: plan.side,
              entry: plan.entry,
              exit: target,
              quantity,
              entryFeeRate: entryFeeRate ?? 0,
              exitFeeRate: exitFeeRate ?? 0,
              slippageRate: (entrySlippageRate + exitSlippageRate) / 2,
              fundingRate:
                quantity > 0
                  ? signedFundingPayment(
                      plan.side,
                      plan.entry * quantity,
                      fundingRate,
                    ) /
                    (plan.entry * quantity)
                  : 0,
            }),
          }))
        : [];
    return json(
      {
        ok: errors.length === 0 && quantityResult.valid,
        errors,
        warnings: quantityResult.warnings,
        quantity: quantity > 0 ? quantity : null,
        maxLoss: quantityResult.maxLoss,
        estimatedMaxLoss: quantityResult.estimatedMaxLoss,
        notional: quantity > 0 ? plan.entry * quantity : null,
        initialMargin: quantity > 0 ? (plan.entry * quantity) / 10 : null,
        targets,
        calculationSource: {
          snapshotId: (JSON.parse(stored.raw) as { snapshotId?: string })
            .snapshotId,
          generatedAt: stored.generatedAt,
          productFilters: filters,
          feeRates: { entryFeeRate, exitFeeRate },
          slippage: { entrySlippageRate, exitSlippageRate },
          fundingRate,
        },
      },
      errors.length === 0 && quantityResult.valid ? 200 : 400,
    );
  }
  return json({ error: 'NOT_FOUND' }, 404);
}

export default { fetch: handler };
