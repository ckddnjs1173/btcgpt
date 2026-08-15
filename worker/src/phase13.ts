import { z } from 'zod';

import { handler as legacyHandler, type Env } from './index';
import { syncDecisionLineageFromSnapshot } from './phase13-lineage';
import {
  attachMarketFingerprintToDecision,
  cacheMarketFingerprintFromSnapshot,
} from './phase15-fingerprint';

const MAX_DECISION_BODY_BYTES = 12_000;
const FUTURE_TOLERANCE_MS = 5_000;
const DECISION_RATE_LIMIT_PER_MINUTE = 60;

const decisionSchema = z
  .object({
    decisionId: z.string().trim().min(1).max(100),
    snapshotId: z.string().trim().min(1).max(100),
    marketGeneratedAt: z.number().int().positive(),
    parentDecisionId: z.string().trim().min(1).max(100).nullable().optional(),
    intent: z.enum(['MARKET_ANALYSIS', 'NEW_ENTRY', 'POSITION_MANAGEMENT']),
    decision: z.enum([
      'ENTER_NOW',
      'WAIT_TRIGGER',
      'NO_TRADE',
      'HOLD',
      'PARTIAL_EXIT',
      'EXIT',
      'MOVE_STOP',
      'CHANGE_TP',
      'DATA_BLOCKED',
    ]),
    side: z.enum(['LONG', 'SHORT', 'NEUTRAL']),
    analysisMode: z.enum(['FAST', 'VERIFY', 'DEEP']).default('FAST'),
    instructionVersion: z.string().trim().min(1).max(80),
    contextPackVersion: z.string().trim().min(1).max(80),
    confidenceBand: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']).default('NONE'),
    planValidation: z
      .enum(['NOT_APPLICABLE', 'NOT_RUN', 'VALIDATED', 'BLOCKED'])
      .default('NOT_APPLICABLE'),
    entry: z.number().positive().nullable().optional(),
    stop: z.number().positive().nullable().optional(),
    targets: z.array(z.number().positive()).max(3).default([]),
    triggerSummary: z.string().trim().max(300).nullable().optional(),
    invalidationSummary: z.string().trim().max(300).nullable().optional(),
    reasonTags: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
    counterThesisTags: z
      .array(z.string().trim().min(1).max(60))
      .max(8)
      .default([]),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.parentDecisionId === decision.decisionId) {
      context.addIssue({
        code: 'custom',
        path: ['parentDecisionId'],
        message: 'parentDecisionId must differ from decisionId',
      });
    }
    if (decision.decision === 'ENTER_NOW') {
      if (decision.side === 'NEUTRAL') {
        context.addIssue({
          code: 'custom',
          path: ['side'],
          message: 'ENTER_NOW requires LONG or SHORT side',
        });
      }
      const missingTradeValues =
        decision.entry === null ||
        decision.entry === undefined ||
        decision.stop === null ||
        decision.stop === undefined ||
        decision.targets.length === 0;
      if (missingTradeValues) {
        context.addIssue({
          code: 'custom',
          path: ['entry'],
          message: 'ENTER_NOW requires entry, stop and at least one target',
        });
      }
    }
  });

type DecisionInput = z.infer<typeof decisionSchema>;

type DecisionRow = {
  snapshotId: string;
  recordedAt: number;
  snapshotStatus: 'CURRENT' | 'SUPERSEDED';
  snapshotToRecordLatencyMs: number;
  payload: string;
};

type LatestSnapshotRow = {
  raw: string;
  generatedAt: number;
};

type DecisionRateBucket = {
  startedAt: number;
  count: number;
};

const decisionRateBuckets = new Map<string, DecisionRateBucket>();

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
  const bucket = decisionRateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= 60_000) {
    decisionRateBuckets.set(key, { startedAt: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > DECISION_RATE_LIMIT_PER_MINUTE;
}

function database(env: Env) {
  if (!env.DB) throw new Error('D1_UNAVAILABLE');
  return env.DB;
}

async function loadLatestSnapshot(env: Env): Promise<LatestSnapshotRow | null> {
  return database(env)
    .prepare(
      `SELECT payload AS raw, generated_at AS generatedAt
       FROM latest_snapshot WHERE id = 1`,
    )
    .first<LatestSnapshotRow>();
}

async function loadDecision(
  env: Env,
  decisionId: string,
): Promise<DecisionRow | null> {
  return database(env)
    .prepare(
      `SELECT snapshot_id AS snapshotId, recorded_at AS recordedAt,
        snapshot_status AS snapshotStatus,
        snapshot_to_record_latency_ms AS snapshotToRecordLatencyMs,
        payload
       FROM decision_log WHERE decision_id = ?`,
    )
    .bind(decisionId)
    .first<DecisionRow>();
}

async function saveDecision(
  env: Env,
  decision: DecisionInput,
  normalizedPayload: string,
  snapshotStatus: 'CURRENT' | 'SUPERSEDED',
  recordedAt: number,
  snapshotToRecordLatencyMs: number,
): Promise<void> {
  const result = await database(env)
    .prepare(
      `INSERT INTO decision_log (
        decision_id, snapshot_id, market_generated_at, recorded_at,
        intent, decision, side, analysis_mode, instruction_version,
        context_pack_version, confidence_band, parent_decision_id,
        snapshot_status, snapshot_to_record_latency_ms, plan_validation,
        entry, stop, targets_json, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      decision.decisionId,
      decision.snapshotId,
      decision.marketGeneratedAt,
      recordedAt,
      decision.intent,
      decision.decision,
      decision.side,
      decision.analysisMode,
      decision.instructionVersion,
      decision.contextPackVersion,
      decision.confidenceBand,
      decision.parentDecisionId ?? null,
      snapshotStatus,
      snapshotToRecordLatencyMs,
      decision.planValidation,
      decision.entry ?? null,
      decision.stop ?? null,
      JSON.stringify(decision.targets),
      normalizedPayload,
    )
    .run();
  if (!result.success) throw new Error('D1_DECISION_WRITE_FAILED');
}

async function recordDecision(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env.ACTION_READ_KEY)) {
    return json({ error: 'UNAUTHORIZED' }, 401);
  }
  if (rateLimited(request)) return json({ error: 'RATE_LIMITED' }, 429);

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_DECISION_BODY_BYTES) {
    return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_DECISION_BODY_BYTES) {
    return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
  }

  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    return json({ error: 'INVALID_JSON' }, 400);
  }

  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) {
    return json(
      {
        error: 'INVALID_DECISION',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400,
    );
  }

  const decision = parsed.data;
  const recordedAt = Date.now();
  if (decision.marketGeneratedAt > recordedAt + FUTURE_TOLERANCE_MS) {
    return json({ error: 'FUTURE_MARKET_GENERATED_AT' }, 400);
  }

  const normalizedPayload = JSON.stringify(decision);

  try {
    const existing = await loadDecision(env, decision.decisionId);
    if (existing) {
      if (existing.payload !== normalizedPayload) {
        return json({ error: 'DECISION_ID_CONFLICT' }, 409);
      }
      try {
        await attachMarketFingerprintToDecision(env, {
          decisionId: decision.decisionId,
          snapshotId: decision.snapshotId,
          marketGeneratedAt: decision.marketGeneratedAt,
          linkedAt: existing.recordedAt,
        });
      } catch {
        // Fingerprint telemetry is analytics-only and must not break idempotency.
      }
      return json({
        ok: true,
        decisionId: decision.decisionId,
        duplicate: true,
        snapshotStatus: existing.snapshotStatus,
        recordedAt: existing.recordedAt,
        snapshotToRecordLatencyMs: existing.snapshotToRecordLatencyMs,
      });
    }

    const latest = await loadLatestSnapshot(env);
    if (!latest) return json({ error: 'SNAPSHOT_NOT_FOUND' }, 409);

    let latestPayload: unknown;
    try {
      latestPayload = JSON.parse(latest.raw) as unknown;
    } catch {
      return json({ error: 'SNAPSHOT_STORAGE_CORRUPT' }, 503);
    }
    if (!latestPayload || typeof latestPayload !== 'object') {
      return json({ error: 'SNAPSHOT_STORAGE_CORRUPT' }, 503);
    }

    const snapshotPayload = latestPayload as { snapshotId?: unknown };
    const latestSnapshotId = snapshotPayload.snapshotId;
    if (typeof latestSnapshotId !== 'string') {
      return json({ error: 'SNAPSHOT_STORAGE_CORRUPT' }, 503);
    }

    const snapshotStatus =
      latestSnapshotId === decision.snapshotId ? 'CURRENT' : 'SUPERSEDED';
    const metadataMismatch =
      snapshotStatus === 'CURRENT' &&
      latest.generatedAt !== decision.marketGeneratedAt;
    if (metadataMismatch) {
      return json({ error: 'SNAPSHOT_METADATA_MISMATCH' }, 409);
    }

    const snapshotToRecordLatencyMs = Math.max(
      0,
      recordedAt - decision.marketGeneratedAt,
    );

    await saveDecision(
      env,
      decision,
      normalizedPayload,
      snapshotStatus,
      recordedAt,
      snapshotToRecordLatencyMs,
    );

    try {
      await attachMarketFingerprintToDecision(env, {
        decisionId: decision.decisionId,
        snapshotId: decision.snapshotId,
        marketGeneratedAt: decision.marketGeneratedAt,
        fallbackSnapshot: latestPayload,
        linkedAt: recordedAt,
      });
    } catch {
      // Decision recording remains authoritative if analytics enrichment fails.
    }

    return json(
      {
        ok: true,
        decisionId: decision.decisionId,
        duplicate: false,
        snapshotStatus,
        recordedAt,
        snapshotToRecordLatencyMs,
      },
      201,
    );
  } catch {
    return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  }
}

export async function handler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const isDecisionRecord =
    request.method === 'POST' && url.pathname === '/v1/decision/record';
  if (isDecisionRecord) return recordDecision(request, env);

  const isSnapshotUpload =
    request.method === 'PUT' && url.pathname === '/v1/snapshot/latest';
  if (isSnapshotUpload) {
    const analyticsRequest = request.clone();
    const response = await legacyHandler(request, env);
    if (response.ok) {
      try {
        const snapshot = (await analyticsRequest.json()) as unknown;
        await Promise.allSettled([
          cacheMarketFingerprintFromSnapshot(env, snapshot),
          syncDecisionLineageFromSnapshot(env, snapshot),
        ]);
      } catch {
        // Analytics sync must never break the live snapshot relay.
      }
    }
    return response;
  }

  return legacyHandler(request, env);
}

export default { fetch: handler };
