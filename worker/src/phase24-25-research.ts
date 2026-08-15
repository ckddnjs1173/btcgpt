import type { Env } from './index';

export const BENCHMARK_VERSION = 'benchmark-v1';
export const SIZING_RESEARCH_VERSION = 'sizing-research-v1';

const MIN_BENCHMARK_MATCHED_CASES = 50;
const MIN_BENCHMARK_DIRECTIONAL_CASES = 20;
const MIN_SIZING_TRADES = 30;
const SIZING_PRIOR_STRENGTH = 20;
const MAX_RESEARCH_TRADES = 1000;

type D1AllStatement = {
  all<T>(): Promise<{ results?: T[]; success: boolean }>;
};

type BenchmarkExperimentRow = {
  experimentId: string;
  name: string;
  provider: string;
  model: string;
  modelVersion: string | null;
  instructionVersion: string;
  contextPackVersion: string;
  analysisMode: string;
  createdAt: number;
};

type BenchmarkRow = {
  decisionId: string;
  liveDecision: string;
  liveSide: string;
  liveAnalysisMode: string;
  liveConfidenceBand: string;
  liveLatencyMs: number | null;
  apiOutputPayload: string | null;
  apiLatencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reportedCostUsd: number | null;
  costBasis: string;
  returnBps30m: number | null;
  maxUpBps30m: number | null;
  maxDownBps30m: number | null;
  realizedNetR: number | null;
  tradeClosedAt: number | null;
};

type SizingRow = {
  decisionId: string;
  closedAt: number;
  realizedNetR: number;
  leverage: number | null;
  analysisMode: string;
  confidenceBand: string;
  contextPackVersion: string;
  entryDriftBps: number | null;
  mfeR: number | null;
  maeR: number | null;
};

type ParsedOutput = {
  decision: string;
  side: 'LONG' | 'SHORT' | 'NEUTRAL';
};

type DirectionMetrics = {
  directionalSamples: number;
  correctSamples: number;
  correctRate: number | null;
  averageSignedReturnBps30m: number | null;
  abstainSamples: number;
  averageAbstainOpportunityBps30m: number | null;
};

type Cohort = {
  key: string;
  sampleCount: number;
  meanNetR: number;
  medianNetR: number;
  winRate: number;
  lowerConfidenceBoundNetR: number | null;
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

function database(env: Env) {
  if (!env.DB) throw new Error('D1_UNAVAILABLE');
  return env.DB;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values);
  if (average === null) return null;
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

function maximumDrawdownR(rows: SizingRow[]): number | null {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort((a, b) => a.closedAt - b.closedAt);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const row of ordered) {
    equity += row.realizedNetR;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return maxDrawdown;
}

function parseOutput(raw: string | null): ParsedOutput | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const decision = parsed.decision;
    const side = parsed.side;
    if (
      typeof decision !== 'string' ||
      (side !== 'LONG' && side !== 'SHORT' && side !== 'NEUTRAL')
    ) {
      return null;
    }
    return { decision, side };
  } catch {
    return null;
  }
}

function opportunityBps(maxUp: number | null, maxDown: number | null) {
  const values = [maxUp, maxDown].filter(
    (value): value is number => value !== null,
  );
  if (values.length === 0) return null;
  return Math.max(...values.map((value) => Math.abs(value)));
}

function signedReturn(
  side: 'LONG' | 'SHORT' | 'NEUTRAL',
  rawReturn: number | null,
): number | null {
  if (side === 'NEUTRAL' || rawReturn === null) return null;
  return side === 'LONG' ? rawReturn : -rawReturn;
}

function directionMetrics(
  rows: BenchmarkRow[],
  source: 'LIVE' | 'API',
): DirectionMetrics {
  const signed: number[] = [];
  const abstainOpportunity: number[] = [];
  let correctSamples = 0;

  for (const row of rows) {
    const api = source === 'API' ? parseOutput(row.apiOutputPayload) : null;
    const side =
      source === 'LIVE'
        ? row.liveSide === 'LONG' || row.liveSide === 'SHORT'
          ? row.liveSide
          : 'NEUTRAL'
        : (api?.side ?? 'NEUTRAL');
    const decision = source === 'LIVE' ? row.liveDecision : api?.decision;
    const value = signedReturn(side, finite(row.returnBps30m));
    if (value !== null) {
      signed.push(value);
      if (value > 0) correctSamples += 1;
      continue;
    }
    if (decision === 'WAIT_TRIGGER' || decision === 'NO_TRADE') {
      const opportunity = opportunityBps(
        finite(row.maxUpBps30m),
        finite(row.maxDownBps30m),
      );
      if (opportunity !== null) abstainOpportunity.push(opportunity);
    }
  }

  return {
    directionalSamples: signed.length,
    correctSamples,
    correctRate: signed.length > 0 ? correctSamples / signed.length : null,
    averageSignedReturnBps30m: mean(signed),
    abstainSamples: abstainOpportunity.length,
    averageAbstainOpportunityBps30m: mean(abstainOpportunity),
  };
}

async function loadExperiment(
  env: Env,
  experimentId: string,
): Promise<BenchmarkExperimentRow | null> {
  return database(env)
    .prepare(
      `SELECT experiment_id AS experimentId, name, provider, model,
        model_version AS modelVersion, instruction_version AS instructionVersion,
        context_pack_version AS contextPackVersion,
        analysis_mode AS analysisMode, created_at AS createdAt
       FROM replay_experiments WHERE experiment_id = ?`,
    )
    .bind(experimentId)
    .first<BenchmarkExperimentRow>();
}

async function benchmarkRows(
  env: Env,
  experimentId: string,
): Promise<BenchmarkRow[]> {
  const statement = database(env)
    .prepare(
      `SELECT d.decision_id AS decisionId, d.decision AS liveDecision,
        d.side AS liveSide, d.analysis_mode AS liveAnalysisMode,
        d.confidence_band AS liveConfidenceBand,
        d.snapshot_to_record_latency_ms AS liveLatencyMs,
        r.output_payload AS apiOutputPayload, r.latency_ms AS apiLatencyMs,
        r.input_tokens AS inputTokens, r.output_tokens AS outputTokens,
        r.cached_input_tokens AS cachedInputTokens,
        r.reported_cost_usd AS reportedCostUsd, r.cost_basis AS costBasis,
        o.return_bps_30m AS returnBps30m,
        o.max_up_bps_30m AS maxUpBps30m,
        o.max_down_bps_30m AS maxDownBps30m,
        l.realized_net_r AS realizedNetR,
        l.trade_closed_at AS tradeClosedAt
       FROM replay_eval_runs r
       JOIN decision_log d ON d.decision_id = r.decision_id
       JOIN replay_case_outcomes o ON o.decision_id = r.decision_id
       LEFT JOIN decision_trade_lineage l ON l.decision_id = r.decision_id
       WHERE r.experiment_id = ?
         AND r.status = 'SCORED'
         AND r.score_status = 'FINAL'
         AND r.output_payload IS NOT NULL
         AND o.finalized_at IS NOT NULL
       ORDER BY d.market_generated_at ASC`,
    )
    .bind(experimentId) as unknown as D1AllStatement;
  const result = await statement.all<BenchmarkRow>();
  return result.results ?? [];
}

function pairwiseAgreement(rows: BenchmarkRow[]) {
  let parsed = 0;
  let decisionMatches = 0;
  let sideMatches = 0;
  for (const row of rows) {
    const api = parseOutput(row.apiOutputPayload);
    if (!api) continue;
    parsed += 1;
    if (api.decision === row.liveDecision) decisionMatches += 1;
    if (api.side === row.liveSide) sideMatches += 1;
  }
  return {
    comparableCases: parsed,
    decisionAgreementRate: parsed > 0 ? decisionMatches / parsed : null,
    sideAgreementRate: parsed > 0 ? sideMatches / parsed : null,
  };
}

function benchmarkEvidence(
  matchedCases: number,
  live: DirectionMetrics,
  api: DirectionMetrics,
  reportedCostSamples: number,
) {
  const accuracyDelta =
    live.correctRate !== null && api.correctRate !== null
      ? api.correctRate - live.correctRate
      : null;
  const signedReturnDelta =
    live.averageSignedReturnBps30m !== null &&
    api.averageSignedReturnBps30m !== null
      ? api.averageSignedReturnBps30m - live.averageSignedReturnBps30m
      : null;
  const sampleGate = matchedCases >= MIN_BENCHMARK_MATCHED_CASES;
  const directionalSampleGate =
    live.directionalSamples >= MIN_BENCHMARK_DIRECTIONAL_CASES &&
    api.directionalSamples >= MIN_BENCHMARK_DIRECTIONAL_CASES;
  return {
    status:
      sampleGate && directionalSampleGate
        ? 'READY_FOR_MANUAL_REVIEW'
        : 'INSUFFICIENT_SAMPLE',
    sampleGate,
    directionalSampleGate,
    costVisibilityComplete:
      matchedCases > 0 && reportedCostSamples === matchedCases,
    accuracyDelta,
    signedReturnDeltaBps30m: signedReturnDelta,
    thresholds: {
      minimumMatchedCases: MIN_BENCHMARK_MATCHED_CASES,
      minimumDirectionalCasesPerArm: MIN_BENCHMARK_DIRECTIONAL_CASES,
    },
    policy:
      'No automatic model promotion. Replay evidence must be reviewed against live Net R, cost, latency, and missed-opportunity metrics.',
  };
}

async function benchmarkResponse(env: Env, experimentId: string) {
  const experiment = await loadExperiment(env, experimentId);
  if (!experiment) return json({ error: 'EXPERIMENT_NOT_FOUND' }, 404);
  const rows = await benchmarkRows(env, experimentId);
  const live = directionMetrics(rows, 'LIVE');
  const api = directionMetrics(rows, 'API');
  const agreement = pairwiseAgreement(rows);
  const apiLatencies = rows
    .map((row) => finite(row.apiLatencyMs))
    .filter((value): value is number => value !== null);
  const liveLatencies = rows
    .map((row) => finite(row.liveLatencyMs))
    .filter((value): value is number => value !== null);
  const costs = rows
    .map((row) => finite(row.reportedCostUsd))
    .filter((value): value is number => value !== null);
  const liveNetR = rows
    .filter((row) => row.tradeClosedAt !== null)
    .map((row) => finite(row.realizedNetR))
    .filter((value): value is number => value !== null);

  return json({
    version: BENCHMARK_VERSION,
    experiment,
    matchedCases: rows.length,
    agreement,
    live,
    api,
    operational: {
      liveAverageDecisionLatencyMs: mean(liveLatencies),
      apiAverageLatencyMs: mean(apiLatencies),
      apiReportedCostSamples: costs.length,
      apiTotalReportedCostUsd:
        costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    },
    actualExecution: {
      closedLinkedTrades: liveNetR.length,
      averageRealizedNetR: mean(liveNetR),
      medianRealizedNetR: median(liveNetR),
      note: 'Actual cost-adjusted Net R exists only for linked executed trades. Replay directional bps are not presented as realized Net R.',
    },
    promotionEvidence: benchmarkEvidence(rows.length, live, api, costs.length),
  });
}

async function sizingRows(env: Env): Promise<SizingRow[]> {
  const statement = database(env)
    .prepare(
      `SELECT l.decision_id AS decisionId, l.trade_closed_at AS closedAt,
        l.realized_net_r AS realizedNetR, l.entry_drift_bps AS entryDriftBps,
        l.mfe_r AS mfeR, l.mae_r AS maeR,
        d.analysis_mode AS analysisMode,
        d.confidence_band AS confidenceBand,
        d.context_pack_version AS contextPackVersion,
        CAST(json_extract(l.payload, '$.plan.leverage') AS REAL) AS leverage
       FROM decision_trade_lineage l
       JOIN decision_log d ON d.decision_id = l.decision_id
       WHERE l.trade_closed_at IS NOT NULL
         AND l.realized_net_r IS NOT NULL
       ORDER BY l.trade_closed_at DESC
       LIMIT ?`,
    )
    .bind(MAX_RESEARCH_TRADES) as unknown as D1AllStatement;
  const result = await statement.all<SizingRow>();
  return result.results ?? [];
}

function lowerConfidenceBound(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values);
  const deviation = standardDeviation(values);
  if (average === null || deviation === null) return null;
  return average - 1.645 * (deviation / Math.sqrt(values.length));
}

function cohort(rows: SizingRow[], key: string): Cohort | null {
  if (rows.length === 0) return null;
  const values = rows.map((row) => row.realizedNetR);
  return {
    key,
    sampleCount: rows.length,
    meanNetR: mean(values) ?? 0,
    medianNetR: median(values) ?? 0,
    winRate: values.filter((value) => value > 0).length / values.length,
    lowerConfidenceBoundNetR: lowerConfidenceBound(values),
  };
}

function groupedCohorts(
  rows: SizingRow[],
  selector: (row: SizingRow) => string,
): Cohort[] {
  const groups = new Map<string, SizingRow[]>();
  for (const row of rows) {
    const key = selector(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => cohort(group, key))
    .filter((value): value is Cohort => value !== null)
    .sort(
      (a, b) => b.sampleCount - a.sampleCount || a.key.localeCompare(b.key),
    );
}

function leverageBucket(leverage: number | null): string {
  if (leverage === null) return 'UNKNOWN';
  if (leverage <= 5) return '1-5x';
  if (leverage <= 10) return '6-10x';
  if (leverage <= 20) return '11-20x';
  if (leverage <= 50) return '21-50x';
  return '51x+';
}

function researchRiskMultiplier(values: number[]) {
  if (values.length < MIN_SIZING_TRADES) return null;
  const average = mean(values) ?? 0;
  const shrunkMean =
    (average * values.length) / (values.length + SIZING_PRIOR_STRENGTH);
  const deviation = standardDeviation(values);
  const lowerBound =
    deviation === null
      ? null
      : shrunkMean - 1.645 * (deviation / Math.sqrt(values.length));
  if (lowerBound === null) return null;
  const multiplier =
    lowerBound <= 0
      ? 0.5
      : lowerBound < 0.1
        ? 0.75
        : lowerBound < 0.25
          ? 1
          : lowerBound < 0.5
            ? 1.1
            : 1.2;
  return {
    multiplier,
    shrunkMeanNetR: shrunkMean,
    lowerConfidenceBoundNetR: lowerBound,
    cap: 1.2,
    priorStrength: SIZING_PRIOR_STRENGTH,
  };
}

async function sizingResponse(env: Env) {
  const rows = await sizingRows(env);
  const values = rows.map((row) => row.realizedNetR);
  const candidate = researchRiskMultiplier(values);
  const entryDrift = rows
    .map((row) => finite(row.entryDriftBps))
    .filter((value): value is number => value !== null);
  const mfe = rows
    .map((row) => finite(row.mfeR))
    .filter((value): value is number => value !== null);
  const mae = rows
    .map((row) => finite(row.maeR))
    .filter((value): value is number => value !== null);

  return json({
    version: SIZING_RESEARCH_VERSION,
    status:
      rows.length >= MIN_SIZING_TRADES
        ? 'RESEARCH_ONLY'
        : 'INSUFFICIENT_SAMPLE',
    sampleCount: rows.length,
    minimumSampleCount: MIN_SIZING_TRADES,
    performance: {
      meanNetR: mean(values),
      medianNetR: median(values),
      winRate:
        values.length > 0
          ? values.filter((value) => value > 0).length / values.length
          : null,
      standardDeviationNetR: standardDeviation(values),
      lowerConfidenceBoundNetR: lowerConfidenceBound(values),
      tenthPercentileNetR: percentile(values, 0.1),
      maxDrawdownR: maximumDrawdownR(rows),
      averageEntryDriftBps: mean(entryDrift),
      medianMfeR: median(mfe),
      medianMaeR: median(mae),
    },
    cohorts: {
      analysisMode: groupedCohorts(rows, (row) => row.analysisMode),
      confidenceBand: groupedCohorts(rows, (row) => row.confidenceBand),
      contextPackVersion: groupedCohorts(rows, (row) => row.contextPackVersion),
      observedLeverage: groupedCohorts(rows, (row) =>
        leverageBucket(finite(row.leverage)),
      ),
    },
    candidateRiskMultiplier: candidate,
    leverageResearch: {
      recommendation: null,
      note: 'Observed leverage cohorts are descriptive only. Leverage is confounded with setup, stop distance, margin and liquidation constraints, so no automatic leverage recommendation is produced.',
    },
    liveActivation: {
      enabled: false,
      requiresExplicitApproval: true,
      note: 'This endpoint never changes user size, margin, leverage, trade plans or Binance state.',
    },
  });
}

export async function handleResearchReadRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const benchmarkMatch = url.pathname.match(
    /^\/v1\/research\/benchmark\/([^/]+)$/,
  );
  const sizingMatch = url.pathname === '/v1/research/performance-sizing';
  if (request.method !== 'GET' || (!benchmarkMatch && !sizingMatch)) {
    return null;
  }
  if (!authorized(request, env.ACTION_READ_KEY)) {
    return json({ error: 'UNAUTHORIZED' }, 401);
  }
  try {
    if (benchmarkMatch) {
      return benchmarkResponse(
        env,
        decodeURIComponent(benchmarkMatch[1] ?? ''),
      );
    }
    return sizingResponse(env);
  } catch {
    return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  }
}
