import type { Env } from './index';

export const RESEARCH_OPS_VERSION = 'research-ops-v2';

const MIN_BENCHMARK_MATCHED_CASES = 50;
const MIN_BENCHMARK_DIRECTIONAL_CASES = 20;
const MIN_SIZING_TRADES = 30;
const PERFORMANCE_WINDOW = 20;
const MAX_PERFORMANCE_ROWS = 1000;
const DEFAULT_CASE_LIMIT = 100;
const MAX_CASE_LIMIT = 500;

const DECISIONS = new Set([
  'ENTER_NOW',
  'WAIT_TRIGGER',
  'NO_TRADE',
  'HOLD',
  'PARTIAL_EXIT',
  'EXIT',
  'MOVE_STOP',
  'CHANGE_TP',
  'DATA_BLOCKED',
]);
const SIDES = new Set(['LONG', 'SHORT', 'NEUTRAL']);
const ANALYSIS_MODES = new Set(['FAST', 'VERIFY', 'DEEP']);

type CountRow = { value: number };
type D1AllStatement = {
  all<T>(): Promise<{ results?: T[]; success: boolean }>;
};

type PerformanceRow = {
  decisionId: string;
  executionMode: string;
  closedAt: number;
  realizedNetR: number;
  mfeR: number | null;
  maeR: number | null;
  entryDriftBps: number | null;
  planLeverage: number | null;
  analysisMode: string;
  confidenceBand: string;
  contextPackVersion: string;
};

type PerformanceCohort = {
  key: string;
  sampleCount: number;
  meanNetR: number | null;
  medianNetR: number | null;
  winRate: number | null;
};

type ReplayCatalogRow = {
  decisionId: string;
  snapshotId: string;
  marketGeneratedAt: number;
  capturedAt: number;
  replayVersion: string;
  payloadSha256: string;
  intent: string;
  decision: string;
  side: string;
  analysisMode: string;
  instructionVersion: string;
  contextPackVersion: string;
  confidenceBand: string;
  fingerprintCompleteness: number | null;
  finalizedAt: number | null;
  outcomeSampleCount: number | null;
};

type DecisionQualityRow = {
  decisionId: string;
  marketGeneratedAt: number;
  decision: string;
  side: string;
  analysisMode: string;
  instructionVersion: string;
  contextPackVersion: string;
  confidenceBand: string;
  returnBps30m: number | null;
  maxUpBps30m: number | null;
  maxDownBps30m: number | null;
};

type DecisionQualityMetrics = {
  totalCases: number;
  enterSamples: number;
  enterCorrectRate: number | null;
  averageEnterSignedReturnBps30m: number | null;
  medianEnterSignedReturnBps30m: number | null;
  medianEnterFavorableBps30m: number | null;
  medianEnterAdverseBps30m: number | null;
  abstainSamples: number;
  averageAbstainOpportunityBps30m: number | null;
  medianAbstainOpportunityBps30m: number | null;
  dataBlockedSamples: number;
  positionManagementSamples: number;
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
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
}

async function count(env: Env, sql: string): Promise<number> {
  const row = await database(env).prepare(sql).first<CountRow>();
  return finite(row?.value) ?? 0;
}

async function performanceSchemaReady(env: Env): Promise<boolean> {
  try {
    await database(env)
      .prepare('SELECT plan_leverage FROM decision_trade_lineage LIMIT 1')
      .first();
    return true;
  } catch {
    return false;
  }
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function boundedString(value: string | null, maxLength: number): string | null {
  if (!value || value.length > maxLength) return null;
  return value;
}

function integerParam(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readinessResponse(env: Env): Promise<Response> {
  const schemaReady = await performanceSchemaReady(env);
  const decisions = await count(
    env,
    'SELECT COUNT(*) AS value FROM decision_log',
  );
  const replayCases = await count(
    env,
    'SELECT COUNT(*) AS value FROM replay_cases',
  );
  const finalizedOutcomes = await count(
    env,
    'SELECT COUNT(*) AS value FROM replay_case_outcomes WHERE finalized_at IS NOT NULL',
  );
  const experiments = await count(
    env,
    'SELECT COUNT(*) AS value FROM replay_experiments',
  );
  const scoredRuns = await count(
    env,
    "SELECT COUNT(*) AS value FROM replay_eval_runs WHERE status = 'SCORED' AND score_status = 'FINAL'",
  );
  const contextV2Decisions = await count(
    env,
    "SELECT COUNT(*) AS value FROM decision_log WHERE context_pack_version = 'context-v2'",
  );
  const closedNetRTrades = schemaReady
    ? await count(
        env,
        'SELECT COUNT(*) AS value FROM decision_trade_lineage WHERE trade_closed_at IS NOT NULL AND realized_net_r IS NOT NULL',
      )
    : 0;

  const nextActions: string[] = [];
  if (!schemaReady) nextActions.push('APPLY_PENDING_D1_MIGRATIONS');
  if (replayCases < MIN_BENCHMARK_MATCHED_CASES)
    nextActions.push('ACCUMULATE_REPLAY_CASES');
  if (finalizedOutcomes < MIN_BENCHMARK_MATCHED_CASES)
    nextActions.push('ACCUMULATE_FINALIZED_OUTCOMES');
  if (closedNetRTrades < MIN_SIZING_TRADES)
    nextActions.push('ACCUMULATE_CLOSED_LINKED_TRADES');
  if (experiments === 0) nextActions.push('REGISTER_REPLAY_EXPERIMENT');
  if (nextActions.length === 0) nextActions.push('REVIEW_BENCHMARK_EVIDENCE');

  return json({
    version: RESEARCH_OPS_VERSION,
    schema: {
      performanceResearch: schemaReady ? 'READY' : 'PENDING_MIGRATION',
      requiredMigration: schemaReady ? null : '0011_performance_research.sql',
    },
    inventory: {
      decisions,
      contextV2Decisions,
      replayCases,
      finalizedOutcomes,
      experiments,
      scoredRuns,
      closedLinkedTradesWithNetR: closedNetRTrades,
    },
    coverage: {
      replayCasePerDecision: ratio(replayCases, decisions),
      finalizedOutcomePerReplayCase: ratio(finalizedOutcomes, replayCases),
      contextV2PerDecision: ratio(contextV2Decisions, decisions),
    },
    evidenceGates: {
      benchmark: {
        minimumMatchedCases: MIN_BENCHMARK_MATCHED_CASES,
        minimumDirectionalCasesPerArm: MIN_BENCHMARK_DIRECTIONAL_CASES,
        note: 'Directional arm readiness is evaluated per experiment by the benchmark endpoint.',
      },
      sizing: {
        minimumClosedLinkedTrades: MIN_SIZING_TRADES,
        currentClosedLinkedTrades: closedNetRTrades,
        readyForResearchCandidate:
          schemaReady && closedNetRTrades >= MIN_SIZING_TRADES,
      },
    },
    safety: {
      automaticModelPromotion: false,
      liveSizingMutation: false,
      liveLeverageMutation: false,
      paidReplayExecution: false,
    },
    nextActions,
  });
}

async function performanceRows(env: Env): Promise<PerformanceRow[]> {
  const statement = database(env)
    .prepare(
      `SELECT l.decision_id AS decisionId, l.mode AS executionMode,
        l.trade_closed_at AS closedAt, l.realized_net_r AS realizedNetR,
        l.mfe_r AS mfeR, l.mae_r AS maeR,
        l.entry_drift_bps AS entryDriftBps,
        l.plan_leverage AS planLeverage,
        d.analysis_mode AS analysisMode,
        d.confidence_band AS confidenceBand,
        d.context_pack_version AS contextPackVersion
       FROM decision_trade_lineage l
       JOIN decision_log d ON d.decision_id = l.decision_id
       WHERE l.trade_closed_at IS NOT NULL
         AND l.realized_net_r IS NOT NULL
       ORDER BY l.trade_closed_at DESC
       LIMIT ?`,
    )
    .bind(MAX_PERFORMANCE_ROWS) as unknown as D1AllStatement;
  const result = await statement.all<PerformanceRow>();
  return result.results ?? [];
}

function cohort(rows: PerformanceRow[], key: string): PerformanceCohort {
  const values = rows.map((row) => row.realizedNetR);
  return {
    key,
    sampleCount: rows.length,
    meanNetR: mean(values),
    medianNetR: median(values),
    winRate:
      values.length > 0
        ? values.filter((value) => value > 0).length / values.length
        : null,
  };
}

function grouped(
  rows: PerformanceRow[],
  selector: (row: PerformanceRow) => string,
): PerformanceCohort[] {
  const groups = new Map<string, PerformanceRow[]>();
  for (const row of rows) {
    const key = selector(row);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }
  return [...groups.entries()]
    .map(([key, group]) => cohort(group, key))
    .sort(
      (a, b) => b.sampleCount - a.sampleCount || a.key.localeCompare(b.key),
    );
}

function leverageBucket(value: number | null): string {
  if (value === null) return 'UNKNOWN';
  if (value <= 5) return '1-5x';
  if (value <= 10) return '6-10x';
  if (value <= 20) return '11-20x';
  if (value <= 50) return '21-50x';
  return '51x+';
}

function performanceWindow(rows: PerformanceRow[]) {
  const recent = rows.slice(0, PERFORMANCE_WINDOW);
  const prior = rows.slice(PERFORMANCE_WINDOW, PERFORMANCE_WINDOW * 2);
  const recentMean = mean(recent.map((row) => row.realizedNetR));
  const priorMean = mean(prior.map((row) => row.realizedNetR));
  return {
    windowSize: PERFORMANCE_WINDOW,
    recentSamples: recent.length,
    priorSamples: prior.length,
    recentMeanNetR: recentMean,
    priorMeanNetR: priorMean,
    recentVsPriorMeanNetRDelta:
      recentMean !== null && priorMean !== null ? recentMean - priorMean : null,
    comparisonReady: recent.length >= 10 && prior.length >= 10,
  };
}

async function feedbackResponse(env: Env): Promise<Response> {
  if (!(await performanceSchemaReady(env))) {
    return json(
      {
        version: RESEARCH_OPS_VERSION,
        status: 'PENDING_MIGRATION',
        requiredMigration: '0011_performance_research.sql',
      },
      409,
    );
  }

  const rows = await performanceRows(env);
  const values = rows.map((row) => row.realizedNetR);
  const mfeCapture = rows
    .map((row) => {
      const mfeR = finite(row.mfeR);
      return mfeR !== null && mfeR > 0 ? row.realizedNetR / mfeR : null;
    })
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
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
    version: RESEARCH_OPS_VERSION,
    status: rows.length >= MIN_SIZING_TRADES ? 'RESEARCH_READY' : 'SPARSE',
    sampleCount: rows.length,
    performance: {
      meanNetR: mean(values),
      medianNetR: median(values),
      winRate:
        values.length > 0
          ? values.filter((value) => value > 0).length / values.length
          : null,
      medianMfeR: median(mfe),
      medianMaeR: median(mae),
      averageEntryDriftBps: mean(entryDrift),
      meanMfeCaptureRatio: mean(mfeCapture),
      medianMfeCaptureRatio: median(mfeCapture),
      mfeCaptureSamples: mfeCapture.length,
      note: 'MFE capture uses realized cost-adjusted Net R divided by observed MFE R and is descriptive, not a sizing signal.',
    },
    drift: performanceWindow(rows),
    cohorts: {
      executionMode: grouped(rows, (row) => row.executionMode),
      analysisMode: grouped(rows, (row) => row.analysisMode),
      confidenceBand: grouped(rows, (row) => row.confidenceBand),
      contextPackVersion: grouped(rows, (row) => row.contextPackVersion),
      observedLeverage: grouped(rows, (row) =>
        leverageBucket(finite(row.planLeverage)),
      ),
    },
    policy: {
      automaticStrategyChange: false,
      automaticSizingChange: false,
      automaticLeverageChange: false,
      note: 'PAPER/LIVE and leverage cohorts are observational and can be confounded. Use them as evidence for manual research review only.',
    },
  });
}

async function replayCatalogResponse(
  env: Env,
  url: URL,
): Promise<Response> {
  const requestedLimit = integerParam(url.searchParams.get('limit'));
  const limit = Math.min(
    MAX_CASE_LIMIT,
    Math.max(1, requestedLimit ?? DEFAULT_CASE_LIMIT),
  );
  const decision = boundedString(url.searchParams.get('decision'), 40);
  const side = boundedString(url.searchParams.get('side'), 20);
  const analysisMode = boundedString(url.searchParams.get('analysisMode'), 20);
  const contextPackVersion = boundedString(
    url.searchParams.get('contextPackVersion'),
    80,
  );
  const instructionVersion = boundedString(
    url.searchParams.get('instructionVersion'),
    80,
  );
  const finalized = url.searchParams.get('finalized');
  const after = integerParam(url.searchParams.get('after'));
  const before = integerParam(url.searchParams.get('before'));

  if (decision && !DECISIONS.has(decision))
    return json({ error: 'INVALID_DECISION_FILTER' }, 400);
  if (side && !SIDES.has(side))
    return json({ error: 'INVALID_SIDE_FILTER' }, 400);
  if (analysisMode && !ANALYSIS_MODES.has(analysisMode))
    return json({ error: 'INVALID_ANALYSIS_MODE_FILTER' }, 400);
  if (finalized !== null && finalized !== 'true' && finalized !== 'false')
    return json({ error: 'INVALID_FINALIZED_FILTER' }, 400);

  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    clauses.push(sql);
    values.push(value);
  };
  if (decision) add('d.decision = ?', decision);
  if (side) add('d.side = ?', side);
  if (analysisMode) add('d.analysis_mode = ?', analysisMode);
  if (contextPackVersion)
    add('d.context_pack_version = ?', contextPackVersion);
  if (instructionVersion) add('d.instruction_version = ?', instructionVersion);
  if (finalized === 'true') clauses.push('o.finalized_at IS NOT NULL');
  if (finalized === 'false') clauses.push('o.finalized_at IS NULL');
  if (after !== null) add('c.market_generated_at >= ?', after);
  if (before !== null) add('c.market_generated_at <= ?', before);

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const statement = database(env)
    .prepare(
      `SELECT c.decision_id AS decisionId, c.snapshot_id AS snapshotId,
        c.market_generated_at AS marketGeneratedAt,
        c.captured_at AS capturedAt, c.replay_version AS replayVersion,
        c.payload_sha256 AS payloadSha256,
        d.intent, d.decision, d.side, d.analysis_mode AS analysisMode,
        d.instruction_version AS instructionVersion,
        d.context_pack_version AS contextPackVersion,
        d.confidence_band AS confidenceBand,
        f.completeness AS fingerprintCompleteness,
        o.finalized_at AS finalizedAt, o.sample_count AS outcomeSampleCount
       FROM replay_cases c
       JOIN decision_log d ON d.decision_id = c.decision_id
       LEFT JOIN replay_case_outcomes o ON o.decision_id = c.decision_id
       LEFT JOIN decision_market_fingerprint f ON f.decision_id = c.decision_id
       ${where}
       ORDER BY c.market_generated_at DESC
       LIMIT ?`,
    )
    .bind(...values, limit) as unknown as D1AllStatement;
  const result = await statement.all<ReplayCatalogRow>();
  const rows = result.results ?? [];
  return json({
    version: RESEARCH_OPS_VERSION,
    count: rows.length,
    limit,
    filters: {
      decision,
      side,
      analysisMode,
      contextPackVersion,
      instructionVersion,
      finalized: finalized === null ? null : finalized === 'true',
      after,
      before,
    },
    cases: rows.map((row) => ({
      decisionId: row.decisionId,
      snapshotId: row.snapshotId,
      marketGeneratedAt: row.marketGeneratedAt,
      capturedAt: row.capturedAt,
      replayVersion: row.replayVersion,
      payloadSha256: row.payloadSha256,
      intent: row.intent,
      decision: row.decision,
      side: row.side,
      analysisMode: row.analysisMode,
      instructionVersion: row.instructionVersion,
      contextPackVersion: row.contextPackVersion,
      confidenceBand: row.confidenceBand,
      fingerprintCompleteness: finite(row.fingerprintCompleteness),
      outcomeFinalized: row.finalizedAt !== null,
      outcomeSampleCount: finite(row.outcomeSampleCount) ?? 0,
    })),
    note: 'Catalog rows expose replay metadata and outcome-finalization status only. Future outcome values are intentionally excluded.',
  });
}

async function decisionQualityRows(env: Env): Promise<DecisionQualityRow[]> {
  const statement = database(env).prepare(
    `SELECT d.decision_id AS decisionId,
      d.market_generated_at AS marketGeneratedAt,
      d.decision, d.side, d.analysis_mode AS analysisMode,
      d.instruction_version AS instructionVersion,
      d.context_pack_version AS contextPackVersion,
      d.confidence_band AS confidenceBand,
      o.return_bps_30m AS returnBps30m,
      o.max_up_bps_30m AS maxUpBps30m,
      o.max_down_bps_30m AS maxDownBps30m
     FROM decision_log d
     JOIN replay_case_outcomes o ON o.decision_id = d.decision_id
     WHERE o.finalized_at IS NOT NULL
     ORDER BY d.market_generated_at ASC`,
  ) as unknown as D1AllStatement;
  const result = await statement.all<DecisionQualityRow>();
  return result.results ?? [];
}

function opportunityBps(row: DecisionQualityRow): number | null {
  const values = [finite(row.maxUpBps30m), finite(row.maxDownBps30m)].filter(
    (value): value is number => value !== null,
  );
  return values.length > 0
    ? Math.max(...values.map((value) => Math.abs(value)))
    : null;
}

function directionalExcursion(
  row: DecisionQualityRow,
): { signed: number; favorable: number | null; adverse: number | null } | null {
  if (row.decision !== 'ENTER_NOW') return null;
  if (row.side !== 'LONG' && row.side !== 'SHORT') return null;
  const rawReturn = finite(row.returnBps30m);
  if (rawReturn === null) return null;
  const up = finite(row.maxUpBps30m);
  const down = finite(row.maxDownBps30m);
  if (row.side === 'LONG') {
    return {
      signed: rawReturn,
      favorable: up === null ? null : Math.max(0, up),
      adverse: down === null ? null : Math.max(0, -down),
    };
  }
  return {
    signed: -rawReturn,
    favorable: down === null ? null : Math.max(0, -down),
    adverse: up === null ? null : Math.max(0, up),
  };
}

function decisionQualityMetrics(
  rows: DecisionQualityRow[],
): DecisionQualityMetrics {
  const signed: number[] = [];
  const favorable: number[] = [];
  const adverse: number[] = [];
  const abstain: number[] = [];
  let dataBlockedSamples = 0;
  let positionManagementSamples = 0;

  for (const row of rows) {
    const excursion = directionalExcursion(row);
    if (excursion) {
      signed.push(excursion.signed);
      if (excursion.favorable !== null) favorable.push(excursion.favorable);
      if (excursion.adverse !== null) adverse.push(excursion.adverse);
      continue;
    }
    if (row.decision === 'WAIT_TRIGGER' || row.decision === 'NO_TRADE') {
      const opportunity = opportunityBps(row);
      if (opportunity !== null) abstain.push(opportunity);
      continue;
    }
    if (row.decision === 'DATA_BLOCKED') {
      dataBlockedSamples += 1;
      continue;
    }
    if (
      row.decision === 'HOLD' ||
      row.decision === 'PARTIAL_EXIT' ||
      row.decision === 'EXIT' ||
      row.decision === 'MOVE_STOP' ||
      row.decision === 'CHANGE_TP'
    ) {
      positionManagementSamples += 1;
    }
  }

  return {
    totalCases: rows.length,
    enterSamples: signed.length,
    enterCorrectRate:
      signed.length > 0
        ? signed.filter((value) => value > 0).length / signed.length
        : null,
    averageEnterSignedReturnBps30m: mean(signed),
    medianEnterSignedReturnBps30m: median(signed),
    medianEnterFavorableBps30m: median(favorable),
    medianEnterAdverseBps30m: median(adverse),
    abstainSamples: abstain.length,
    averageAbstainOpportunityBps30m: mean(abstain),
    medianAbstainOpportunityBps30m: median(abstain),
    dataBlockedSamples,
    positionManagementSamples,
  };
}

function qualityCohorts(
  rows: DecisionQualityRow[],
  selector: (row: DecisionQualityRow) => string,
) {
  const groups = new Map<string, DecisionQualityRow[]>();
  for (const row of rows) {
    const key = selector(row);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...decisionQualityMetrics(group) }))
    .sort((a, b) => b.totalCases - a.totalCases || a.key.localeCompare(b.key));
}

async function decisionQualityResponse(env: Env): Promise<Response> {
  const rows = await decisionQualityRows(env);
  return json({
    version: RESEARCH_OPS_VERSION,
    horizon: '30m',
    samplingBasis: 'RELAY_MARK_PRICE',
    finalizedCases: rows.length,
    overall: decisionQualityMetrics(rows),
    cohorts: {
      decision: qualityCohorts(rows, (row) => row.decision),
      analysisMode: qualityCohorts(rows, (row) => row.analysisMode),
      instructionVersion: qualityCohorts(rows, (row) => row.instructionVersion),
      contextPackVersion: qualityCohorts(rows, (row) => row.contextPackVersion),
      confidenceBand: qualityCohorts(rows, (row) => row.confidenceBand),
    },
    notes: [
      'ENTER_NOW direction metrics use the original side and the frozen 30m future path.',
      'WAIT_TRIGGER and NO_TRADE report missed-opportunity magnitude without assigning a scalar penalty.',
      'Position-management decisions are counted separately because a 30m direction score is not an execution-quality metric for management actions.',
      'No local strategy score or automatic promotion decision is produced.',
    ],
  });
}

export async function handleResearchOpsRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const readiness = url.pathname === '/v1/research/readiness';
  const feedback = url.pathname === '/v1/research/feedback';
  const cases = url.pathname === '/v1/research/cases';
  const decisionQuality = url.pathname === '/v1/research/decision-quality';
  if (
    request.method !== 'GET' ||
    (!readiness && !feedback && !cases && !decisionQuality)
  )
    return null;
  if (!authorized(request, env.ACTION_READ_KEY)) {
    return json({ error: 'UNAUTHORIZED' }, 401);
  }
  try {
    if (readiness) return readinessResponse(env);
    if (feedback) return feedbackResponse(env);
    if (cases) return replayCatalogResponse(env, url);
    return decisionQualityResponse(env);
  } catch {
    return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  }
}
