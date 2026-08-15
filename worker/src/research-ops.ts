import type { Env } from './index';

export const RESEARCH_OPS_VERSION = 'research-ops-v1';

const MIN_BENCHMARK_MATCHED_CASES = 50;
const MIN_BENCHMARK_DIRECTIONAL_CASES = 20;
const MIN_SIZING_TRADES = 30;
const PERFORMANCE_WINDOW = 20;
const MAX_PERFORMANCE_ROWS = 1000;

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

export async function handleResearchOpsRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const readiness = url.pathname === '/v1/research/readiness';
  const feedback = url.pathname === '/v1/research/feedback';
  if (request.method !== 'GET' || (!readiness && !feedback)) return null;
  if (!authorized(request, env.ACTION_READ_KEY)) {
    return json({ error: 'UNAUTHORIZED' }, 401);
  }
  try {
    return readiness ? readinessResponse(env) : feedbackResponse(env);
  } catch {
    return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  }
}
