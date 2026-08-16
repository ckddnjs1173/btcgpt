import type { Env } from './index';
import {
  evaluateEnterPlan,
  evaluateManagementDecision,
  evaluateWaitTrigger,
  parsePricePathJson,
} from './evaluation-v2';
import { structuredTriggerInputSchema } from '../../src/shared/trading/structured-trigger';

export const REPLAY_CASE_VERSION = 'replay-v1';
const SNAPSHOT_LEASE_TTL_MS = 30 * 60_000;
const OUTCOME_GRACE_MS = 10 * 60_000;
const OUTCOME_HORIZONS = [
  ['1m', 60_000],
  ['3m', 3 * 60_000],
  ['5m', 5 * 60_000],
  ['15m', 15 * 60_000],
  ['30m', 30 * 60_000],
  ['60m', 60 * 60_000],
] as const;
const MAX_OUTCOME_HORIZON_MS = OUTCOME_HORIZONS.at(-1)?.[1] ?? 60 * 60_000;

type RecordLike = Record<string, unknown>;

type ReplayLeaseRow = {
  marketGeneratedAt: number;
  leasedAt: number;
  payloadBytes: number;
  payloadSha256: string;
  payload: string;
};

type ReplayCaseInputRow = {
  decisionId: string;
  snapshotId: string;
  marketGeneratedAt: number;
  replayVersion: string;
  sourceLeaseAt: number;
  capturedAt: number;
  anchorMarkPrice: number | null;
  payloadBytes: number;
  payloadSha256: string;
  snapshotPayload: string;
};

type FingerprintRow = {
  fingerprintVersion: string;
  completeness: number;
  payload: string;
};

type DecisionOutcomeRow = {
  recordedAt: number;
  intent: string;
  decision: string;
  side: string;
  analysisMode: string;
  confidenceBand: string;
  planValidation: string;
  payload: string;
};

type ReplayOutcomeRow = {
  marketGeneratedAt: number;
  anchorMarkPrice: number | null;
  firstFutureObservedAt: number | null;
  lastFutureObservedAt: number | null;
  sampleCount: number;
  maxUpBps1m: number | null;
  maxDownBps1m: number | null;
  returnBps1m: number | null;
  returnObservedAt1m: number | null;
  maxUpBps3m: number | null;
  maxDownBps3m: number | null;
  returnBps3m: number | null;
  returnObservedAt3m: number | null;
  maxUpBps5m: number | null;
  maxDownBps5m: number | null;
  returnBps5m: number | null;
  returnObservedAt5m: number | null;
  maxUpBps15m: number | null;
  maxDownBps15m: number | null;
  returnBps15m: number | null;
  returnObservedAt15m: number | null;
  maxUpBps30m: number | null;
  maxDownBps30m: number | null;
  returnBps30m: number | null;
  returnObservedAt30m: number | null;
  maxUpBps60m: number | null;
  maxDownBps60m: number | null;
  returnBps60m: number | null;
  returnObservedAt60m: number | null;
  pricePathVersion: string;
  pricePathJson: string;
  lastPathObservedAt: number | null;
  finalizedAt: number | null;
};

type TradeQualityRow = {
  planId: string | null;
  mode: string | null;
  tradeId: string | null;
  tradeStatus: string | null;
  realizedNetPnl: number | null;
  decisionToPlanLockMs: number | null;
  triggerToTradeOpenMs: number | null;
  entryTimingQuality: string | null;
  plannedEntry: number | null;
  actualEntry: number | null;
  entryDriftBps: number | null;
  initialRiskUsdt: number | null;
  mfeBps: number | null;
  maeBps: number | null;
  mfeR: number | null;
  maeR: number | null;
  realizedNetR: number | null;
  holdingTimeMs: number | null;
  costBasis: string | null;
};

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function at(root: RecordLike | null, ...path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
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

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (part) =>
    part.toString(16).padStart(2, '0'),
  ).join('');
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function replayInputBasis(
  snapshot: unknown,
): 'DECISION_CONTEXT' | 'MARKET_SNAPSHOT' {
  const root = asRecord(snapshot);
  return root?.version === 'decision-context-v1'
    ? 'DECISION_CONTEXT'
    : 'MARKET_SNAPSHOT';
}

function replayMarketGeneratedAt(snapshot: unknown): number | null {
  const root = asRecord(snapshot);
  return asNumber(root?.marketGeneratedAt) ?? asNumber(root?.generatedAt);
}

function anchorMarkPrice(snapshot: unknown): number | null {
  const root = asRecord(snapshot);
  return (
    asNumber(at(root, 'btcCore', 'marketState', 'markPrice')) ??
    asNumber(at(root, 'marketState', 'markPrice'))
  );
}

export async function saveReplaySnapshotLease(
  env: Env,
  snapshotResponse: unknown,
  leasedAt = Date.now(),
): Promise<boolean> {
  if (!env.DB) return false;
  const root = asRecord(snapshotResponse);
  const snapshotId =
    root && typeof root.snapshotId === 'string' ? root.snapshotId : null;
  const marketGeneratedAt = replayMarketGeneratedAt(snapshotResponse);
  if (!snapshotId || marketGeneratedAt === null) return false;

  const payload = JSON.stringify(snapshotResponse);
  const payloadBytes = bytes(payload);
  const payloadSha256 = await sha256(payload);
  const result = await env.DB.prepare(
    `INSERT INTO replay_snapshot_lease (
      snapshot_id, market_generated_at, leased_at, expires_at,
      payload_bytes, payload_sha256, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_id) DO UPDATE SET
      market_generated_at=excluded.market_generated_at,
      leased_at=excluded.leased_at,
      expires_at=excluded.expires_at,
      payload_bytes=excluded.payload_bytes,
      payload_sha256=excluded.payload_sha256,
      payload=excluded.payload
    WHERE excluded.leased_at >= replay_snapshot_lease.leased_at`,
  )
    .bind(
      snapshotId,
      marketGeneratedAt,
      leasedAt,
      leasedAt + SNAPSHOT_LEASE_TTL_MS,
      payloadBytes,
      payloadSha256,
      payload,
    )
    .run();
  if (!result.success) throw new Error('D1_REPLAY_LEASE_WRITE_FAILED');

  await env.DB.prepare('DELETE FROM replay_snapshot_lease WHERE expires_at < ?')
    .bind(leasedAt)
    .run();
  return true;
}

async function loadReplayLease(
  env: Env,
  snapshotId: string,
  marketGeneratedAt: number,
): Promise<ReplayLeaseRow | null> {
  if (!env.DB) return null;
  return env.DB.prepare(
    `SELECT market_generated_at AS marketGeneratedAt,
      leased_at AS leasedAt, payload_bytes AS payloadBytes,
      payload_sha256 AS payloadSha256, payload
     FROM replay_snapshot_lease
     WHERE snapshot_id = ? AND market_generated_at = ?`,
  )
    .bind(snapshotId, marketGeneratedAt)
    .first<ReplayLeaseRow>();
}

export async function attachReplayCaseToDecision(
  env: Env,
  input: {
    decisionId: string;
    snapshotId: string;
    marketGeneratedAt: number;
    capturedAt?: number;
  },
): Promise<boolean> {
  if (!env.DB) return false;
  const lease = await loadReplayLease(
    env,
    input.snapshotId,
    input.marketGeneratedAt,
  );
  if (!lease) return false;

  const snapshot = safeParse(lease.payload);
  const markPrice = anchorMarkPrice(snapshot);
  const capturedAt = input.capturedAt ?? Date.now();
  const replayResult = await env.DB.prepare(
    `INSERT INTO replay_cases (
      decision_id, snapshot_id, market_generated_at, replay_version,
      source_lease_at, captured_at, anchor_mark_price, payload_bytes,
      payload_sha256, snapshot_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(decision_id) DO NOTHING`,
  )
    .bind(
      input.decisionId,
      input.snapshotId,
      input.marketGeneratedAt,
      REPLAY_CASE_VERSION,
      lease.leasedAt,
      capturedAt,
      markPrice,
      lease.payloadBytes,
      lease.payloadSha256,
      lease.payload,
    )
    .run();
  if (!replayResult.success) throw new Error('D1_REPLAY_CASE_WRITE_FAILED');

  const outcomeResult = await env.DB.prepare(
    `INSERT INTO replay_case_outcomes (
      decision_id, market_generated_at, anchor_mark_price
    ) VALUES (?, ?, ?)
    ON CONFLICT(decision_id) DO NOTHING`,
  )
    .bind(input.decisionId, input.marketGeneratedAt, markPrice)
    .run();
  if (!outcomeResult.success) throw new Error('D1_REPLAY_OUTCOME_INIT_FAILED');
  return true;
}

function pricePathAssignments(): string {
  const age = '(?1 - market_generated_at)';
  const interval = `CASE
    WHEN ${age} <= ${5 * 60_000} THEN 5000
    WHEN ${age} <= ${15 * 60_000} THEN 15000
    ELSE 30000 END`;
  const due = `(${age} > 0 AND ${age} <= ${60 * 60_000}
    AND (last_path_observed_at IS NULL OR (?1 - last_path_observed_at) >= (${interval})))`;
  return `
    price_path_json=CASE WHEN ${due}
      THEN json_insert(COALESCE(price_path_json, '[]'), '$[#]', json_array(${age}, ?2))
      ELSE price_path_json END,
    last_path_observed_at=CASE WHEN ${due}
      THEN ?1 ELSE last_path_observed_at END`;
}

function horizonAssignments(
  suffix: (typeof OUTCOME_HORIZONS)[number][0],
  horizonMs: number,
): string {
  const age = '(?1 - market_generated_at)';
  const move = '((?2 - anchor_mark_price) / anchor_mark_price) * 10000.0';
  return `
    max_up_bps_${suffix}=CASE
      WHEN ${age} > 0 AND ${age} <= ${horizonMs}
      THEN CASE
        WHEN max_up_bps_${suffix} IS NULL OR ${move} > max_up_bps_${suffix}
        THEN ${move} ELSE max_up_bps_${suffix} END
      ELSE max_up_bps_${suffix} END,
    max_down_bps_${suffix}=CASE
      WHEN ${age} > 0 AND ${age} <= ${horizonMs}
      THEN CASE
        WHEN max_down_bps_${suffix} IS NULL OR ${move} < max_down_bps_${suffix}
        THEN ${move} ELSE max_down_bps_${suffix} END
      ELSE max_down_bps_${suffix} END,
    return_bps_${suffix}=CASE
      WHEN return_bps_${suffix} IS NULL AND ${age} >= ${horizonMs}
      THEN ${move} ELSE return_bps_${suffix} END,
    return_observed_at_${suffix}=CASE
      WHEN return_observed_at_${suffix} IS NULL AND ${age} >= ${horizonMs}
      THEN ?1 ELSE return_observed_at_${suffix} END`;
}

export async function updateReplayOutcomesFromSnapshot(
  env: Env,
  snapshot: unknown,
): Promise<void> {
  if (!env.DB) return;
  const root = asRecord(snapshot);
  const observedAt = asNumber(root?.generatedAt);
  const markPrice = asNumber(at(root, 'marketState', 'markPrice'));
  if (observedAt === null || markPrice === null || markPrice <= 0) return;

  const assignments = OUTCOME_HORIZONS.map(([suffix, horizonMs]) =>
    horizonAssignments(suffix, horizonMs),
  ).join(',');
  const pathAssignments = pricePathAssignments();
  const result = await env.DB.prepare(
    `UPDATE replay_case_outcomes SET
      first_future_observed_at=COALESCE(first_future_observed_at, ?1),
      last_future_observed_at=?1,
      sample_count=sample_count + 1,
      ${assignments},
      ${pathAssignments},
      finalized_at=CASE
        WHEN finalized_at IS NULL AND (?1 - market_generated_at) >= ${MAX_OUTCOME_HORIZON_MS}
        THEN ?1 ELSE finalized_at END
     WHERE finalized_at IS NULL
       AND anchor_mark_price IS NOT NULL
       AND anchor_mark_price > 0
       AND market_generated_at < ?1
       AND market_generated_at >= ?1 - ${MAX_OUTCOME_HORIZON_MS + OUTCOME_GRACE_MS}`,
  )
    .bind(observedAt, markPrice)
    .run();
  if (!result.success) throw new Error('D1_REPLAY_OUTCOME_UPDATE_FAILED');
}

async function readReplayInput(
  env: Env,
  decisionId: string,
): Promise<Response> {
  if (!env.DB) return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  const replay = await env.DB.prepare(
    `SELECT decision_id AS decisionId, snapshot_id AS snapshotId,
      market_generated_at AS marketGeneratedAt,
      replay_version AS replayVersion, source_lease_at AS sourceLeaseAt,
      captured_at AS capturedAt, anchor_mark_price AS anchorMarkPrice,
      payload_bytes AS payloadBytes, payload_sha256 AS payloadSha256,
      snapshot_payload AS snapshotPayload
     FROM replay_cases WHERE decision_id = ?`,
  )
    .bind(decisionId)
    .first<ReplayCaseInputRow>();
  if (!replay) return json({ error: 'REPLAY_CASE_NOT_FOUND' }, 404);

  const fingerprint = await env.DB.prepare(
    `SELECT fingerprint_version AS fingerprintVersion,
      completeness, payload
     FROM decision_market_fingerprint WHERE decision_id = ?`,
  )
    .bind(decisionId)
    .first<FingerprintRow>();

  const frozenInput = safeParse(replay.snapshotPayload);
  return json({
    decisionId: replay.decisionId,
    replayVersion: replay.replayVersion,
    inputBasis: replayInputBasis(frozenInput),
    snapshotId: replay.snapshotId,
    marketGeneratedAt: replay.marketGeneratedAt,
    sourceLeaseAt: replay.sourceLeaseAt,
    capturedAt: replay.capturedAt,
    anchorMarkPrice: replay.anchorMarkPrice,
    payloadBytes: replay.payloadBytes,
    payloadSha256: replay.payloadSha256,
    snapshot: frozenInput,
    marketFingerprint: fingerprint
      ? {
          version: fingerprint.fingerprintVersion,
          completeness: fingerprint.completeness,
          fingerprint: safeParse(fingerprint.payload),
        }
      : null,
  });
}

function decisionEvaluationV2(input: {
  decision: DecisionOutcomeRow;
  outcome: ReplayOutcomeRow | null;
  tradeQuality: TradeQualityRow | null;
}): unknown {
  const { decision, outcome, tradeQuality } = input;
  if (!outcome || outcome.anchorMarkPrice === null)
    return { available: false, reason: 'OUTCOME_UNAVAILABLE' };
  const pricePath = parsePricePathJson(outcome.pricePathJson);
  if (pricePath.length === 0)
    return { available: false, reason: 'PRICE_PATH_UNAVAILABLE' };
  const payload = asRecord(safeParse(decision.payload));
  const side =
    decision.side === 'LONG' || decision.side === 'SHORT'
      ? decision.side
      : 'NEUTRAL';

  if (decision.decision === 'ENTER_NOW' && side !== 'NEUTRAL') {
    const entry = asNumber(payload?.entry);
    const stop = asNumber(payload?.stop);
    const targets = Array.isArray(payload?.targets)
      ? payload.targets
          .map(asNumber)
          .filter((value): value is number => value !== null)
      : [];
    if (entry === null || stop === null || targets.length === 0)
      return { available: false, reason: 'PLAN_UNAVAILABLE' };
    return evaluateEnterPlan({
      side,
      anchorMarkPrice: outcome.anchorMarkPrice,
      entry,
      stop,
      targets,
      pricePath,
      realizedNetR: tradeQuality?.realizedNetR ?? null,
      entryDriftBps: tradeQuality?.entryDriftBps ?? null,
    });
  }

  if (decision.decision === 'WAIT_TRIGGER') {
    const parsedTrigger = structuredTriggerInputSchema.safeParse(
      payload?.triggerContract,
    );
    if (!parsedTrigger.success)
      return { available: false, reason: 'STRUCTURED_TRIGGER_UNAVAILABLE' };
    return evaluateWaitTrigger({
      side,
      marketGeneratedAt: outcome.marketGeneratedAt,
      anchorMarkPrice: outcome.anchorMarkPrice,
      triggerContract: parsedTrigger.data,
      pricePath,
    });
  }

  if (
    decision.decision === 'HOLD' ||
    decision.decision === 'PARTIAL_EXIT' ||
    decision.decision === 'EXIT' ||
    decision.decision === 'MOVE_STOP' ||
    decision.decision === 'CHANGE_TP'
  ) {
    return evaluateManagementDecision({
      decision: decision.decision,
      side,
      anchorMarkPrice: outcome.anchorMarkPrice,
      pricePath,
      realizedNetR: tradeQuality?.realizedNetR ?? null,
    });
  }

  return {
    available: true,
    decision: decision.decision,
    performanceScored: false,
    note:
      decision.decision === 'NO_TRADE'
        ? 'NO_TRADE is described by future opportunity vectors; no scalar penalty is assigned.'
        : 'DATA_BLOCKED is counted but not performance-scored.',
  };
}

async function readReplayOutcome(
  env: Env,
  decisionId: string,
): Promise<Response> {
  if (!env.DB) return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  const decision = await env.DB.prepare(
    `SELECT recorded_at AS recordedAt, intent, decision, side,
      analysis_mode AS analysisMode, confidence_band AS confidenceBand,
      plan_validation AS planValidation, payload
     FROM decision_log WHERE decision_id = ?`,
  )
    .bind(decisionId)
    .first<DecisionOutcomeRow>();
  if (!decision) return json({ error: 'DECISION_NOT_FOUND' }, 404);

  const outcome = await env.DB.prepare(
    `SELECT market_generated_at AS marketGeneratedAt,
      anchor_mark_price AS anchorMarkPrice,
      first_future_observed_at AS firstFutureObservedAt,
      last_future_observed_at AS lastFutureObservedAt,
      sample_count AS sampleCount,
      max_up_bps_1m AS maxUpBps1m, max_down_bps_1m AS maxDownBps1m,
      return_bps_1m AS returnBps1m, return_observed_at_1m AS returnObservedAt1m,
      max_up_bps_3m AS maxUpBps3m, max_down_bps_3m AS maxDownBps3m,
      return_bps_3m AS returnBps3m, return_observed_at_3m AS returnObservedAt3m,
      max_up_bps_5m AS maxUpBps5m, max_down_bps_5m AS maxDownBps5m,
      return_bps_5m AS returnBps5m, return_observed_at_5m AS returnObservedAt5m,
      max_up_bps_15m AS maxUpBps15m, max_down_bps_15m AS maxDownBps15m,
      return_bps_15m AS returnBps15m, return_observed_at_15m AS returnObservedAt15m,
      max_up_bps_30m AS maxUpBps30m, max_down_bps_30m AS maxDownBps30m,
      return_bps_30m AS returnBps30m, return_observed_at_30m AS returnObservedAt30m,
      max_up_bps_60m AS maxUpBps60m, max_down_bps_60m AS maxDownBps60m,
      return_bps_60m AS returnBps60m, return_observed_at_60m AS returnObservedAt60m,
      price_path_version AS pricePathVersion, price_path_json AS pricePathJson,
      last_path_observed_at AS lastPathObservedAt, finalized_at AS finalizedAt
     FROM replay_case_outcomes WHERE decision_id = ?`,
  )
    .bind(decisionId)
    .first<ReplayOutcomeRow>();

  const tradeQuality = await env.DB.prepare(
    `SELECT plan_id AS planId, mode, trade_id AS tradeId,
      trade_status AS tradeStatus, realized_net_pnl AS realizedNetPnl,
      decision_to_plan_lock_ms AS decisionToPlanLockMs,
      trigger_to_trade_open_ms AS triggerToTradeOpenMs,
      entry_timing_quality AS entryTimingQuality,
      planned_entry AS plannedEntry, actual_entry AS actualEntry,
      entry_drift_bps AS entryDriftBps, initial_risk_usdt AS initialRiskUsdt,
      mfe_bps AS mfeBps, mae_bps AS maeBps, mfe_r AS mfeR, mae_r AS maeR,
      realized_net_r AS realizedNetR, holding_time_ms AS holdingTimeMs,
      cost_basis AS costBasis
     FROM decision_trade_lineage WHERE decision_id = ?`,
  )
    .bind(decisionId)
    .first<TradeQualityRow>();

  return json({
    decisionId,
    originalDecision: {
      recordedAt: decision.recordedAt,
      intent: decision.intent,
      decision: decision.decision,
      side: decision.side,
      analysisMode: decision.analysisMode,
      confidenceBand: decision.confidenceBand,
      planValidation: decision.planValidation,
      structuredPayload: safeParse(decision.payload),
    },
    futurePath: outcome
      ? {
          ...outcome,
          pricePath: parsePricePathJson(outcome.pricePathJson),
        }
      : null,
    tradeQuality,
    evaluationV2: decisionEvaluationV2({ decision, outcome, tradeQuality }),
    samplingBasis: 'RELAY_MARK_PRICE',
  });
}

export async function handleReplayReadRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  const match = url.pathname.match(
    /^\/v1\/replay\/case\/([^/]+)\/(input|outcome)$/,
  );
  if (!match) return null;
  if (!authorized(request, env.ACTION_READ_KEY))
    return json({ error: 'UNAUTHORIZED' }, 401);

  let decisionId: string;
  try {
    decisionId = decodeURIComponent(match[1] ?? '');
  } catch {
    return json({ error: 'INVALID_DECISION_ID' }, 400);
  }
  if (!decisionId || decisionId.length > 100)
    return json({ error: 'INVALID_DECISION_ID' }, 400);

  try {
    return match[2] === 'input'
      ? await readReplayInput(env, decisionId)
      : await readReplayOutcome(env, decisionId);
  } catch {
    return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  }
}
