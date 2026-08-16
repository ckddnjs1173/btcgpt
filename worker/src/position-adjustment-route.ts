import { z } from 'zod';

import { validatePositionAdjustment } from '../../src/shared/calculations/position-adjustment';
import { applyRelayFreshness } from './relay-freshness';
import type { Env } from './index';

const targetSchema = z
  .object({
    price: z.number().positive().max(10_000_000),
    requestedPercent: z.number().positive().max(100),
  })
  .strict();

const requestSchema = z
  .object({
    snapshotId: z.string().trim().min(1).max(100),
    action: z.enum(['PARTIAL_EXIT', 'EXIT', 'MOVE_STOP', 'CHANGE_TP']),
    requestedQuantity: z.number().positive().max(100).optional(),
    requestedPercent: z.number().positive().max(100).optional(),
    stopPrice: z.number().positive().max(10_000_000).optional(),
    targets: z.array(targetSchema).min(1).max(3).optional(),
    exitOrderType: z.enum(['MAKER', 'TAKER']).default('TAKER'),
  })
  .strict();

const recordSchema = z.record(z.string(), z.unknown());
const MAX_REQUEST_BYTES = 16_000;

type SnapshotRow = {
  raw: string;
  generatedAt: number;
  receivedAt: number;
};

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

function authorized(request: Request, expected: string): boolean {
  const value = request.headers.get('authorization');
  const actual = value?.startsWith('Bearer ') ? value.slice(7) : null;
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1)
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function record(value: unknown): Record<string, unknown> | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function loadSnapshot(env: Env): Promise<SnapshotRow | null> {
  if (!env.DB) throw new Error('DB_UNAVAILABLE');
  return env.DB.prepare(
    `SELECT payload AS raw, generated_at AS generatedAt,
      received_at AS receivedAt FROM latest_snapshot WHERE id = 1`,
  ).first<SnapshotRow>();
}

export async function handlePositionAdjustmentRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!authorized(request, env.ACTION_READ_KEY))
    return json({ error: 'UNAUTHORIZED' }, 401);

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_REQUEST_BYTES)
    return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES)
    return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);

  const parsed = (() => {
    try {
      return requestSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  })();
  if (!parsed) return json({ ok: false, errors: ['INVALID_REQUEST'] }, 400);

  let stored: SnapshotRow | null;
  try {
    stored = await loadSnapshot(env);
  } catch {
    return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  }
  if (!stored) return json({ error: 'NOT_FOUND' }, 404);

  let snapshot: Record<string, unknown>;
  try {
    snapshot = applyRelayFreshness(
      JSON.parse(stored.raw) as Record<string, unknown>,
      stored.generatedAt,
      stored.receivedAt,
      Date.now(),
    );
  } catch {
    return json({ error: 'INVALID_STORED_SNAPSHOT' }, 503);
  }

  const currentSnapshotId =
    typeof snapshot.snapshotId === 'string' ? snapshot.snapshotId : null;
  if (currentSnapshotId !== parsed.snapshotId)
    return json(
      {
        ok: false,
        errors: ['SNAPSHOT_CHANGED_REVALIDATE'],
        requestedSnapshotId: parsed.snapshotId,
        currentSnapshotId,
      },
      409,
    );

  const gates = record(snapshot.decisionGates);
  if (!gates || gates.positionManagementAvailable !== true)
    return json({ ok: false, errors: ['POSITION_MANAGEMENT_NOT_AVAILABLE'] });

  const position = record(snapshot.position);
  const positionSource =
    position && typeof position.source === 'string' ? position.source : 'NONE';
  const side =
    position?.side === 'LONG' || position?.side === 'SHORT'
      ? position.side
      : null;
  const quantity = finite(position?.quantity);
  const marketState = record(snapshot.marketState);
  const markPrice =
    finite(position?.markPrice) ?? finite(marketState?.markPrice) ?? null;
  const filters = record(snapshot.productFilters);
  const costSettings = record(snapshot.costSettings);
  const trading = record(snapshot.trading);
  const liveManual = record(trading?.liveManual);
  const protectiveCoverage = record(liveManual?.protectiveCoverage);

  if (!side || quantity === null || quantity <= 0 || markPrice === null)
    return json({ ok: false, errors: ['OPEN_POSITION_REQUIRED'] });
  if (!filters)
    return json({ ok: false, errors: ['PRODUCT_FILTERS_REQUIRED'] });

  const tickSize = finite(filters.tickSize);
  const stepSize = finite(filters.stepSize);
  const minQuantity = finite(filters.minQuantity);
  const minNotional = finite(filters.minNotional);
  if (
    tickSize === null ||
    stepSize === null ||
    minQuantity === null ||
    minNotional === null
  )
    return json({ ok: false, errors: ['PRODUCT_FILTERS_REQUIRED'] });

  const result = validatePositionAdjustment(parsed, {
    side,
    quantity,
    markPrice,
    filters: { tickSize, stepSize, minQuantity, minNotional },
    costSettings: {
      makerFeeRate: finite(costSettings?.makerFeeRate),
      takerFeeRate: finite(costSettings?.takerFeeRate),
      exitSlippageBps: finite(costSettings?.exitSlippageBps),
    },
    currentProtection: {
      stopLossQuantity: finite(protectiveCoverage?.stopLossQuantity) ?? 0,
      takeProfitQuantity: finite(protectiveCoverage?.takeProfitQuantity) ?? 0,
    },
  });

  return json({
    ok: result.valid,
    snapshotId: currentSnapshotId,
    marketGeneratedAt: finite(snapshot.generatedAt),
    positionSource,
    side,
    currentQuantity: quantity,
    markPrice,
    ...result,
  });
}
