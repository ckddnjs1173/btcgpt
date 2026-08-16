import { z } from 'zod';

import { handleDecisionContextRequest } from './decision-context-route';
import { handlePositionAdjustmentRequest } from './position-adjustment-route';
import {
  calculatePositionPlan,
  isStepAligned,
  signedFundingPayment,
  validateExactPositionSize,
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
    schemaVersion: z.union([
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
    appVersion: z.string().max(30).optional(),
    snapshotId: z.string().min(1).max(100),
    symbol: z.literal('BTCUSDT'),
    market: z.literal('BINANCE_USDM_PERPETUAL'),
    generatedAt: z.number().int().positive(),
    scalpContext: z.unknown().optional(),
    timeframes: z.record(z.string(), z.unknown()).optional(),
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
    decisionGates: z
      .object({
        marketAnalysisAvailable: z.boolean(),
        entryAllowed: z.boolean(),
        positionManagementAvailable: z.boolean(),
        quality: z.enum(['GREEN', 'YELLOW', 'RED']),
        generatedAt: z.number().int().positive(),
        publishedAt: z.number().int().positive().nullable(),
        ageMs: z.number(),
        marketDataAgeMs: z.number().optional(),
        relayPublishAgeMs: z.number().nullable().optional(),
        criticalBlockers: z.array(z.string()),
        degradedSources: z.array(z.string()),
        missingFields: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .passthrough()
  .superRefine((snapshot, context) => {
    if (
      snapshot.schemaVersion >= 3 &&
      (!snapshot.scalpContext ||
        !snapshot.timeframes ||
        !Object.hasOwn(snapshot.timeframes, '1m'))
    )
      context.addIssue({
        code: 'custom',
        message:
          'Schema version 3 or newer requires scalpContext and 1m timeframe',
      });
    if (snapshot.schemaVersion >= 5 && !snapshot.decisionGates)
      context.addIssue({
        code: 'custom',
        message: 'Schema version 5 or newer requires decisionGates',
      });
  });

const contextStatusSchema = z.enum([
  'INITIALIZING',
  'NORMAL',
  'DELAYED',
  'STALE',
  'DISCONNECTED',
  'INSUFFICIENT_DATA',
  'DISABLED',
  'UNAVAILABLE',
]);
const contextItemSchema = z
  .object({
    id: z.string().min(1).max(100),
    source: z.string().min(1).max(80),
    category: z.enum([
      'BINANCE',
      'MACRO',
      'REGULATION',
      'NEWS',
      'OPTIONS',
      'ONCHAIN',
      'SENTIMENT',
    ]),
    title: z.string().min(1).max(240),
    snippet: z.string().max(500).nullable(),
    url: z.url().refine((url) => url.startsWith('https://')),
    publishedAt: z.number().int().positive(),
    observedAt: z.number().int().positive(),
    trustTier: z.enum([
      'OFFICIAL',
      'MULTI_SOURCE',
      'SINGLE_SOURCE',
      'UNVERIFIED_SOCIAL',
    ]),
    btcRelevance: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    duplicateGroupId: z.string().max(100).nullable(),
    duplicateCount: z.number().int().positive().max(1_000),
    tags: z.array(z.string().max(40)).max(12),
  })
  .passthrough();
const riskContextSchema = z
  .object({
    status: contextStatusSchema,
    updatedAt: z.number().int().positive().nullable(),
    highRiskNews: z.boolean(),
    representativeEventId: z.string().max(100).nullable(),
    nextMacroEvent: z
      .object({
        name: z.string().max(200),
        at: z.number().int().positive(),
        remainingMs: z.number(),
      })
      .nullable(),
    binanceCriticalNotice: z.boolean(),
    optionsVolatilityState: z.string().max(100).nullable(),
    onchainAnomaly: z.boolean(),
    fearAndGreed: z
      .object({
        value: z.number().min(0).max(100),
        classification: z.string().max(80),
        at: z.number().int().positive(),
      })
      .nullable(),
    sourceWarnings: z.array(z.string().max(160)).max(20),
  })
  .strict();
const contextSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    generatedAt: z.number().int().positive(),
    status: contextStatusSchema,
    horizon: z.enum(['INTRADAY', 'SWING', 'MACRO']),
    items: z.array(contextItemSchema).max(120),
    sourceHealth: z.record(z.string(), z.unknown()),
    riskContext: riskContextSchema,
    optionsV2: z.unknown().nullable().optional(),
    onchainV1: z.unknown().nullable().optional(),
  })
  .strict();
const contextUploadSchema = z
  .object({
    schemaVersion: z.literal(2),
    generatedAt: z.number().int().positive(),
    snapshot: contextSnapshotSchema,
  })
  .strict();

const planSchema = z
  .object({
    snapshotId: z.string().min(1).max(100).optional(),
    side: z.enum(['LONG', 'SHORT']),
    entry: z.number().positive(),
    stop: z.number().positive(),
    targets: z.array(z.number().positive()).min(1).max(3),
    maxLossUsdt: z.number().positive().optional(),
    riskPercent: z.number().positive().max(1).optional(),
    entryOrderType: z.enum(['MAKER', 'TAKER']).default('TAKER'),
    exitOrderType: z.enum(['MAKER', 'TAKER']).default('TAKER'),
    expectedFundingPeriods: z.number().int().min(0).max(12).default(0),
    leverage: z.number().int().min(1).max(150).default(10),
    sizeMode: z.enum([
      'MARGIN_USDT',
      'QUANTITY_BTC',
      'NOTIONAL_USDT',
      'MAX_LOSS_USDT',
    ]),
    sizeValue: z.number().positive(),
    marginMode: z.literal('ISOLATED'),
  })
  .strict();

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
      FORBIDDEN_SNAPSHOT_KEYS.has(
        key.toLowerCase().replace(/[^a-z0-9]/g, ''),
      ) || containsForbiddenSnapshotKey(nested),
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

function validationFailure(
  errors: string[],
  status = 400,
  warnings: string[] = [],
): Response {
  return json({ ok: false, errors, warnings }, status);
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

function requireDatabase(env: Env): D1Database {
  if (!env.DB) throw new Error('D1_UNAVAILABLE');
  return env.DB;
}

async function save(env: Env, raw: string, generatedAt: number): Promise<void> {
  const receivedAt = Date.now();
  const result = await requireDatabase(env)
    .prepare(
      `
      INSERT INTO latest_snapshot (id, payload, generated_at, received_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,
        generated_at=excluded.generated_at, received_at=excluded.received_at
      WHERE excluded.generated_at >= latest_snapshot.generated_at
    `,
    )
    .bind(raw, generatedAt, receivedAt)
    .run();
  if (!result.success) throw new Error('D1_WRITE_FAILED');
  const snapshot = JSON.parse(raw) as { trading?: unknown };
  if (snapshot.trading !== undefined) {
    const tradingResult = await requireDatabase(env)
      .prepare(
        `INSERT INTO latest_trading_state
          (id, payload, generated_at, received_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,
           generated_at=excluded.generated_at, received_at=excluded.received_at
         WHERE excluded.generated_at >= latest_trading_state.generated_at + 10000`,
      )
      .bind(JSON.stringify(snapshot.trading), generatedAt, receivedAt)
      .run();
    if (!tradingResult.success)
      throw new Error('D1_TRADING_STATE_WRITE_FAILED');
  }
}

async function load(env: Env) {
  return requireDatabase(env)
    .prepare(
      'SELECT payload AS raw, generated_at AS generatedAt, received_at AS receivedAt FROM latest_snapshot WHERE id = 1',
    )
    .first<{ raw: string; generatedAt: number; receivedAt: number }>();
}

async function loadTradingState(env: Env) {
  return requireDatabase(env)
    .prepare(
      `SELECT payload AS raw, generated_at AS generatedAt,
        received_at AS receivedAt
       FROM latest_trading_state WHERE id = 1`,
    )
    .first<{ raw: string; generatedAt: number; receivedAt: number }>();
}

async function saveContext(
  env: Env,
  parsed: z.infer<typeof contextUploadSchema>,
): Promise<void> {
  const receivedAt = Date.now();
  const snapshot = parsed.snapshot;
  const result = await requireDatabase(env)
    .prepare(
      `INSERT INTO external_context_payloads
          (horizon, payload, generated_at, received_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(horizon) DO UPDATE SET payload=excluded.payload,
           generated_at=excluded.generated_at, received_at=excluded.received_at
         WHERE excluded.generated_at >= external_context_payloads.generated_at`,
    )
    .bind(
      snapshot.horizon,
      JSON.stringify(snapshot),
      snapshot.generatedAt,
      receivedAt,
    )
    .run();
  if (!result.success) throw new Error('D1_CONTEXT_WRITE_FAILED');
  if (snapshot.horizon !== 'INTRADAY') return;
  const summary = snapshot.riskContext;
  const summaryResult = await requireDatabase(env)
    .prepare(
      `INSERT INTO external_context_summary
        (id, payload, generated_at, received_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,
         generated_at=excluded.generated_at, received_at=excluded.received_at
       WHERE excluded.generated_at >= external_context_summary.generated_at`,
    )
    .bind(JSON.stringify(summary), parsed.generatedAt, receivedAt)
    .run();
  if (!summaryResult.success)
    throw new Error('D1_CONTEXT_SUMMARY_WRITE_FAILED');
}

async function loadContext(env: Env, horizon: string) {
  return requireDatabase(env)
    .prepare(
      `SELECT payload AS raw, generated_at AS generatedAt,
        received_at AS receivedAt
       FROM external_context_payloads WHERE horizon = ?`,
    )
    .bind(horizon)
    .first<{ raw: string; generatedAt: number; receivedAt: number }>();
}

async function loadRiskContext(env: Env) {
  return requireDatabase(env)
    .prepare(
      `SELECT payload AS raw, generated_at AS generatedAt
       FROM external_context_summary WHERE id = 1`,
    )
    .first<{ raw: string; generatedAt: number }>();
}

export async function handler(request: Request, env: Env): Promise<Response> {
  if (rateLimited(request)) return json({ error: 'RATE_LIMITED' }, 429);
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    try {
      await requireDatabase(env).prepare('SELECT 1 AS ok').first();
      return json({ ok: true, storage: 'D1' });
    } catch {
      return json({ ok: false, error: 'STORAGE_UNAVAILABLE' }, 503);
    }
  }

  if (request.method === 'GET' && url.pathname === '/v1/uploader/status') {
    if (!authorized(request, env.UPLOADER_WRITE_KEY))
      return json({ error: 'UNAUTHORIZED' }, 401);
    try {
      await requireDatabase(env).prepare('SELECT 1 AS ok').first();
      return json({ ok: true, storage: 'D1' });
    } catch {
      return json({ ok: false, error: 'STORAGE_UNAVAILABLE' }, 503);
    }
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
    try {
      await save(env, raw, parsed.generatedAt);
      return json({ ok: true, receivedAt: now });
    } catch {
      return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
    }
  }

  if (
    url.pathname === '/v1/decision-context/latest' &&
    request.method === 'GET'
  )
    return handleDecisionContextRequest(request, env);

  if (
    url.pathname === '/v1/position-adjustment/validate' &&
    request.method === 'POST'
  )
    return handlePositionAdjustmentRequest(request, env);

  if (url.pathname === '/v1/snapshot/latest' && request.method === 'GET') {
    if (!authorized(request, env.ACTION_READ_KEY))
      return json({ error: 'UNAUTHORIZED' }, 401);
    let stored;
    try {
      stored = await load(env);
    } catch {
      return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
    }
    if (!stored) return json({ error: 'NOT_FOUND' }, 404);
    const ageMs = Date.now() - stored.generatedAt;
    const payload = JSON.parse(stored.raw) as Record<string, unknown>;
    const originalGate =
      (payload.analysisGate as Record<string, unknown> | undefined) ?? {};
    payload.analysisGate = {
      ...originalGate,
      ageMs,
      publishedAt: stored.receivedAt,
    };
    const originalDecisionGates = payload.decisionGates as
      Record<string, unknown> | undefined;
    if (originalDecisionGates) {
      const criticalBlockers = [
        ...((originalDecisionGates.criticalBlockers as string[] | undefined) ??
          []),
      ];
      const degradedSources = [
        ...((originalDecisionGates.degradedSources as string[] | undefined) ??
          []),
      ];
      let marketAnalysisAvailable =
        originalDecisionGates.marketAnalysisAvailable === true;
      let entryAllowed = originalDecisionGates.entryAllowed === true;
      let positionManagementAvailable =
        originalDecisionGates.positionManagementAvailable === true;
      const storedQuality = originalDecisionGates.quality;
      let quality =
        storedQuality === 'GREEN' ||
        storedQuality === 'YELLOW' ||
        storedQuality === 'RED'
          ? storedQuality
          : 'RED';

      if (ageMs > 30_000) {
        marketAnalysisAvailable = false;
        entryAllowed = false;
        positionManagementAvailable = false;
        quality = 'RED';
        criticalBlockers.push('RELAY_SNAPSHOT_STALE');
      } else if (ageMs > MAX_SNAPSHOT_AGE_MS) {
        marketAnalysisAvailable = false;
        entryAllowed = false;
        quality = positionManagementAvailable ? 'YELLOW' : 'RED';
        criticalBlockers.push('RELAY_ENTRY_SNAPSHOT_STALE');
      } else if (ageMs > 8_000) {
        if (quality === 'GREEN') quality = 'YELLOW';
        degradedSources.push('relay:DELAYED');
      }

      payload.decisionGates = {
        ...originalDecisionGates,
        marketAnalysisAvailable,
        entryAllowed,
        positionManagementAvailable,
        quality,
        publishedAt: stored.receivedAt,
        ageMs,
        relayPublishAgeMs: ageMs,
        criticalBlockers: [...new Set(criticalBlockers)],
        degradedSources: [...new Set(degradedSources)],
      };
    }
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
    } else if (ageMs > 8_000 && originalGate.overallStatus === 'NORMAL') {
      payload.analysisGate = {
        ...(payload.analysisGate as Record<string, unknown>),
        overallStatus: 'DELAYED',
        reasons: [
          ...((originalGate.reasons as string[] | undefined) ?? []),
          'RELAY_SNAPSHOT_DELAYED',
        ],
      };
    }
    const responseBody: Record<string, unknown> = {
      ...payload,
      relayReceivedAt: stored.receivedAt,
    };
    try {
      const summary = await loadRiskContext(env);
      if (summary) {
        const risk = JSON.parse(summary.raw) as Record<string, unknown>;
        const riskAgeMs = Date.now() - summary.generatedAt;
        responseBody.riskContext = {
          ...risk,
          status:
            riskAgeMs > 60 * 60_000 ? 'STALE' : (risk.status ?? 'UNAVAILABLE'),
          ageMs: riskAgeMs,
        };
      } else {
        responseBody.riskContext = {
          status: 'UNAVAILABLE',
          updatedAt: null,
          highRiskNews: false,
          sourceWarnings: ['EXTERNAL_CONTEXT_NOT_FOUND'],
        };
      }
    } catch {
      responseBody.riskContext = {
        status: 'UNAVAILABLE',
        updatedAt: null,
        highRiskNews: false,
        sourceWarnings: ['EXTERNAL_CONTEXT_STORAGE_UNAVAILABLE'],
      };
    }
    if (
      new TextEncoder().encode(JSON.stringify(responseBody)).byteLength >
      MAX_BODY_BYTES
    )
      return json({ error: 'RESPONSE_TOO_LARGE' }, 500);
    return json(responseBody);
  }

  if (url.pathname === '/v1/trading-state/latest' && request.method === 'GET') {
    if (!authorized(request, env.ACTION_READ_KEY))
      return json({ error: 'UNAUTHORIZED' }, 401);
    let stored;
    try {
      stored = await loadTradingState(env);
    } catch {
      return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
    }
    if (!stored) return json({ error: 'NOT_FOUND' }, 404);
    const ageMs = Date.now() - stored.generatedAt;
    const payload = JSON.parse(stored.raw) as Record<string, unknown>;
    return json({
      ...payload,
      generatedAt: stored.generatedAt,
      relayReceivedAt: stored.receivedAt,
      ageMs,
      relayStatus:
        ageMs > 30_000 ? 'STALE' : ageMs > 15_000 ? 'DELAYED' : 'NORMAL',
    });
  }

  if (url.pathname === '/v1/context/latest' && request.method === 'PUT') {
    if (!authorized(request, env.UPLOADER_WRITE_KEY))
      return json({ error: 'UNAUTHORIZED' }, 401);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES)
      return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    const candidate = contextUploadSchema.safeParse(
      (() => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return null;
        }
      })(),
    );
    if (!candidate.success)
      return json({ error: 'INVALID_EXTERNAL_CONTEXT' }, 400);
    if (
      candidate.data.generatedAt > Date.now() + FUTURE_TOLERANCE_MS ||
      candidate.data.snapshot.items.some(
        (contextItem) =>
          contextItem.publishedAt > Date.now() + FUTURE_TOLERANCE_MS,
      )
    )
      return json({ error: 'FUTURE_EXTERNAL_CONTEXT' }, 400);
    try {
      await saveContext(env, candidate.data);
      return json({ ok: true, receivedAt: Date.now() });
    } catch {
      return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
    }
  }

  if (url.pathname === '/v1/context/latest' && request.method === 'GET') {
    if (!authorized(request, env.ACTION_READ_KEY))
      return json({ error: 'UNAUTHORIZED' }, 401);
    const horizon = url.searchParams.get('horizon');
    if (!['INTRADAY', 'SWING', 'MACRO'].includes(horizon ?? ''))
      return json({ error: 'INVALID_HORIZON' }, 400);
    try {
      const storedContext = await loadContext(env, horizon!);
      if (!storedContext) return json({ error: 'NOT_FOUND' }, 404);
      const payload = JSON.parse(storedContext.raw) as Record<string, unknown>;
      const ageMs = Date.now() - storedContext.generatedAt;
      if (ageMs > 60 * 60_000) payload.status = 'STALE';
      const responseBody = {
        ...payload,
        ageMs,
        relayReceivedAt: storedContext.receivedAt,
      };
      if (
        new TextEncoder().encode(JSON.stringify(responseBody)).byteLength >
        MAX_BODY_BYTES
      )
        return json({ error: 'RESPONSE_TOO_LARGE' }, 500);
      return json(responseBody);
    } catch {
      return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
    }
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
    if (errors.length > 0) return validationFailure(errors);
    let stored;
    try {
      stored = await load(env);
    } catch {
      return validationFailure(['STORAGE_UNAVAILABLE'], 503);
    }
    if (!stored) return validationFailure(['SNAPSHOT_NOT_FOUND'], 409);
    if (Date.now() - stored.generatedAt > MAX_SNAPSHOT_AGE_MS)
      return validationFailure(['SNAPSHOT_STALE'], 409);
    const snapshot = JSON.parse(stored.raw) as {
      schemaVersion?: number;
      snapshotId?: string;
      analysisGate?: { analysisAllowed?: boolean };
      decisionGates?: { entryAllowed?: boolean };
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
      account?: {
        availableBalance?: number | null;
        leverageBrackets?: Array<{
          initialLeverage: number;
          notionalFloor: number;
          notionalCap: number;
          maintenanceMarginRate: number;
          updatedAt: number;
        }>;
      };
      strategy?: {
        maxLossUsdt?: number | null;
        riskPercent?: number | null;
      };
    };
    if (plan.snapshotId && plan.snapshotId !== snapshot.snapshotId)
      return validationFailure(['SNAPSHOT_CHANGED_REVALIDATE'], 409);
    const entryAllowed =
      (snapshot.schemaVersion ?? 0) >= 5
        ? snapshot.decisionGates?.entryAllowed === true
        : snapshot.analysisGate?.analysisAllowed === true;
    if (!entryAllowed) return validationFailure(['ENTRY_NOT_ALLOWED'], 409);
    const filters = snapshot.productFilters;
    if (
      !filters?.tickSize ||
      !filters.stepSize ||
      !filters.minQuantity ||
      !filters.minNotional
    )
      return validationFailure(['PRODUCT_FILTERS_MISSING'], 409);
    const tickSize = filters.tickSize;
    if (plan.targets.some((target) => !isStepAligned(target, tickSize)))
      return validationFailure(['TARGET_NOT_ALIGNED_TO_TICK_SIZE']);
    const maker = snapshot.costSettings?.makerFeeRate;
    const taker = snapshot.costSettings?.takerFeeRate;
    const entryFeeRate = plan.entryOrderType === 'MAKER' ? maker : taker;
    const exitFeeRate = plan.exitOrderType === 'MAKER' ? maker : taker;
    if (entryFeeRate === null || entryFeeRate === undefined)
      errors.push('ENTRY_FEE_RATE_REQUIRED');
    if (exitFeeRate === null || exitFeeRate === undefined)
      errors.push('EXIT_FEE_RATE_REQUIRED');
    const entrySlippageBps = snapshot.costSettings?.entrySlippageBps;
    const exitSlippageBps = snapshot.costSettings?.exitSlippageBps;
    if (entrySlippageBps === null || entrySlippageBps === undefined)
      errors.push('ENTRY_SLIPPAGE_REQUIRED');
    if (exitSlippageBps === null || exitSlippageBps === undefined)
      errors.push('EXIT_SLIPPAGE_REQUIRED');
    if (errors.length > 0) return validationFailure(errors);
    if (
      typeof entrySlippageBps !== 'number' ||
      typeof exitSlippageBps !== 'number'
    )
      return validationFailure(['SLIPPAGE_INPUT_REQUIRED']);
    const entrySlippageRate = entrySlippageBps / 10_000;
    const exitSlippageRate = exitSlippageBps / 10_000;
    const lossPerUnit =
      Math.abs(plan.entry - plan.stop) +
      plan.entry *
        ((entryFeeRate ?? 0) + Math.max(entrySlippageRate, exitSlippageRate)) +
      plan.stop *
        ((exitFeeRate ?? 0) + Math.max(entrySlippageRate, exitSlippageRate));
    const provisionalQuantity =
      plan.sizeMode === 'MARGIN_USDT'
        ? (plan.sizeValue * plan.leverage) / plan.entry
        : plan.sizeMode === 'QUANTITY_BTC'
          ? plan.sizeValue
          : plan.sizeMode === 'NOTIONAL_USDT'
            ? plan.sizeValue / plan.entry
            : plan.sizeValue / lossPerUnit;
    const provisionalNotional = provisionalQuantity * plan.entry;
    const brackets = snapshot.account?.leverageBrackets ?? [];
    const bracket = brackets.find(
      (candidate) =>
        provisionalNotional >= candidate.notionalFloor &&
        provisionalNotional <= candidate.notionalCap,
    );
    if (!bracket) return validationFailure(['LEVERAGE_BRACKET_REQUIRED'], 409);
    if (Date.now() - bracket.updatedAt > 5 * 60_000)
      return validationFailure(['LEVERAGE_BRACKET_STALE'], 409);
    const quantityResult = validateExactPositionSize({
      side: plan.side,
      entry: plan.entry,
      stop: plan.stop,
      leverage: plan.leverage,
      sizeMode: plan.sizeMode,
      sizeValue: plan.sizeValue,
      maximumLeverage: bracket.initialLeverage,
      maximumNotional: bracket.notionalCap,
      maintenanceMarginRate: bracket.maintenanceMarginRate,
      maxLossUsdt:
        plan.maxLossUsdt ??
        (plan.sizeMode === 'MAX_LOSS_USDT'
          ? plan.sizeValue
          : snapshot.strategy?.maxLossUsdt),
      accountEquity: snapshot.account?.availableBalance,
      riskPercent: plan.riskPercent ?? snapshot.strategy?.riskPercent,
      availableMargin: snapshot.account?.availableBalance,
      entryFeeRate: entryFeeRate ?? 0,
      exitFeeRate: exitFeeRate ?? 0,
      slippageRate: Math.max(entrySlippageRate, exitSlippageRate),
      stepSize: filters.stepSize,
      minQuantity: filters.minQuantity,
      minNotional: filters.minNotional,
      tickSize: filters.tickSize,
    });
    if (!quantityResult.valid)
      return validationFailure(
        quantityResult.reasons,
        400,
        quantityResult.warnings,
      );
    const quantity = quantityResult.quantity;
    const fundingRate =
      (snapshot.marketState?.fundingRate ?? 0) * plan.expectedFundingPeriods;
    const minimumNetMarginRoiPercent = 2;
    const targets =
      quantity > 0
        ? plan.targets.map((target) => {
            const calculation = calculatePositionPlan({
              side: plan.side,
              entry: plan.entry,
              exit: target,
              quantity,
              entryFeeRate: entryFeeRate ?? 0,
              exitFeeRate: exitFeeRate ?? 0,
              entrySlippageRate,
              exitSlippageRate,
              leverage: plan.leverage,
              fundingRate:
                quantity > 0
                  ? signedFundingPayment(
                      plan.side,
                      plan.entry * quantity,
                      fundingRate,
                    ) /
                    (plan.entry * quantity)
                  : 0,
            });
            const netMarginRoiPercent =
              (calculation.netPnl / calculation.initialMargin) * 100;
            return {
              target,
              ...calculation,
              netMarginRoiPercent,
              meetsMinimumNetMarginRoi:
                netMarginRoiPercent >= minimumNetMarginRoiPercent,
            };
          })
        : [];
    const warnings = [...quantityResult.warnings];
    if (targets.some((target) => !target.meetsMinimumNetMarginRoi))
      warnings.push('TARGET_NET_MARGIN_ROI_BELOW_MINIMUM');
    return json(
      {
        ok: true,
        errors: [],
        warnings,
        quantity: quantity > 0 ? quantity : null,
        maxLoss: quantityResult.maxLoss,
        estimatedMaxLoss: quantityResult.estimatedMaxLoss,
        notional: quantity > 0 ? plan.entry * quantity : null,
        initialMargin:
          quantity > 0 ? (plan.entry * quantity) / plan.leverage : null,
        requestedQuantity: quantityResult.requestedQuantity,
        estimatedLiquidationPrice: quantityResult.estimatedLiquidationPrice,
        liquidationDistancePercent: quantityResult.liquidationDistancePercent,
        maximumAllowed: {
          leverage: bracket.initialLeverage,
          notional: bracket.notionalCap,
          quantity: quantityResult.maximumQuantity,
          margin: quantityResult.maximumMargin,
        },
        targets,
        calculationSource: {
          snapshotId: snapshot.snapshotId,
          generatedAt: stored.generatedAt,
          productFilters: filters,
          feeRates: { entryFeeRate, exitFeeRate },
          slippage: { entrySlippageRate, exitSlippageRate },
          fundingRate,
        },
      },
      200,
    );
  }
  return json({ error: 'NOT_FOUND' }, 404);
}

export default { fetch: handler };
