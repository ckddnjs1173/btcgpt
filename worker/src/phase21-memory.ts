import type { Env } from './index';
import {
  buildMarketFingerprint,
  type MarketFingerprint,
} from './phase15-fingerprint';

export const TRADING_MEMORY_VERSION = 'memory-v1';
const MAX_CANDIDATES = 300;
const MAX_ANALOGS = 5;
const MIN_OVERLAP_FEATURES = 30;
const MIN_FEATURE_COVERAGE = 0.5;

type MemoryRow = {
  decisionId: string;
  marketGeneratedAt: number;
  fingerprintPayload: string;
  decision: string;
  side: string;
  confidenceBand: string;
  returnBps5m: number | null;
  maxUpBps5m: number | null;
  maxDownBps5m: number | null;
  returnBps15m: number | null;
  maxUpBps15m: number | null;
  maxDownBps15m: number | null;
  returnBps30m: number | null;
  maxUpBps30m: number | null;
  maxDownBps30m: number | null;
  returnBps60m: number | null;
  maxUpBps60m: number | null;
  maxDownBps60m: number | null;
};

type D1AllStatement = {
  all<T>(): Promise<{ results?: T[]; success: boolean }>;
};

type OutcomePoint = {
  returnBps: number | null;
  maxUpBps: number | null;
  maxDownBps: number | null;
};

export type HistoricalAnalog = {
  decisionId: string;
  marketGeneratedAt: number;
  similarity: number;
  featureCoverage: number;
  overlappingFeatures: number;
  historicalDecision: string;
  historicalSide: string;
  historicalConfidenceBand: string;
  outcome: {
    '5m': OutcomePoint;
    '15m': OutcomePoint;
    '30m': OutcomePoint;
    '60m': OutcomePoint;
  };
};

export type TradingMemoryContext = {
  version: typeof TRADING_MEMORY_VERSION;
  status: 'READY' | 'SPARSE' | 'NO_MATCH' | 'UNAVAILABLE';
  generatedAt: number;
  candidateCount: number;
  comparableCount: number;
  analogs: HistoricalAnalog[];
  outcomeSummary: Record<
    '5m' | '15m' | '30m' | '60m',
    {
      sampleCount: number;
      medianReturnBps: number | null;
      positiveReturnCount: number;
      negativeReturnCount: number;
    }
  >;
  policy: string;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clip(value: number, minimum = -2, maximum = 2): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedFeature(name: string, value: number): number {
  if (name.includes('rsi14')) return clip((value - 50) / 25);
  if (name.includes('fearAndGreed')) return clip((value - 50) / 25);
  if (name.includes('tradesPerSecond')) {
    return clip(Math.log1p(Math.max(0, value)) / 3, 0, 2);
  }
  if (name.includes('volumeZScore')) return Math.tanh(value / 3);
  if (name.includes('impactBpsPerBtc')) return Math.tanh(value / 25);
  if (name.includes('nextMacroEventMinutes')) return Math.tanh(value / 120);
  if (name.includes('Bps') || name.includes('bps'))
    return Math.tanh(value / 50);
  if (
    name.includes('Percent') ||
    name.includes('Pct') ||
    name.includes('percent')
  ) {
    return Math.tanh(value / 2);
  }
  return clip(value);
}

function similarity(
  current: MarketFingerprint,
  historical: MarketFingerprint,
): {
  similarity: number;
  featureCoverage: number;
  overlappingFeatures: number;
} | null {
  const currentPresent = Object.entries(current.features).filter(
    ([, value]) => value !== null,
  );
  if (currentPresent.length === 0) return null;

  let overlappingFeatures = 0;
  let absoluteDistance = 0;
  for (const [name, currentValue] of currentPresent) {
    const historicalValue = finiteNumber(historical.features[name]);
    if (currentValue === null || historicalValue === null) continue;
    overlappingFeatures += 1;
    absoluteDistance += Math.abs(
      normalizedFeature(name, currentValue) -
        normalizedFeature(name, historicalValue),
    );
  }

  const featureCoverage = overlappingFeatures / currentPresent.length;
  if (
    overlappingFeatures < MIN_OVERLAP_FEATURES ||
    featureCoverage < MIN_FEATURE_COVERAGE
  ) {
    return null;
  }

  const meanDistance = absoluteDistance / overlappingFeatures;
  return {
    similarity: Math.exp(-1.35 * meanDistance) * Math.sqrt(featureCoverage),
    featureCoverage,
    overlappingFeatures,
  };
}

function parseFingerprint(payload: string): MarketFingerprint | null {
  try {
    const parsed = JSON.parse(payload) as MarketFingerprint;
    if (
      parsed?.version !== 'mf-v1' ||
      !parsed.features ||
      typeof parsed.features !== 'object'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function outcome(
  row: MemoryRow,
  horizon: '5m' | '15m' | '30m' | '60m',
): OutcomePoint {
  const returns = {
    '5m': row.returnBps5m,
    '15m': row.returnBps15m,
    '30m': row.returnBps30m,
    '60m': row.returnBps60m,
  } as const;
  const maxUps = {
    '5m': row.maxUpBps5m,
    '15m': row.maxUpBps15m,
    '30m': row.maxUpBps30m,
    '60m': row.maxUpBps60m,
  } as const;
  const maxDowns = {
    '5m': row.maxDownBps5m,
    '15m': row.maxDownBps15m,
    '30m': row.maxDownBps30m,
    '60m': row.maxDownBps60m,
  } as const;
  return {
    returnBps: returns[horizon],
    maxUpBps: maxUps[horizon],
    maxDownBps: maxDowns[horizon],
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function summarize(
  analogs: HistoricalAnalog[],
): TradingMemoryContext['outcomeSummary'] {
  const result = {} as TradingMemoryContext['outcomeSummary'];
  for (const horizon of ['5m', '15m', '30m', '60m'] as const) {
    const values = analogs
      .map((analog) => analog.outcome[horizon].returnBps)
      .filter((value): value is number => value !== null);
    result[horizon] = {
      sampleCount: values.length,
      medianReturnBps: median(values),
      positiveReturnCount: values.filter((value) => value > 0).length,
      negativeReturnCount: values.filter((value) => value < 0).length,
    };
  }
  return result;
}

function unavailable(now: number): TradingMemoryContext {
  return {
    version: TRADING_MEMORY_VERSION,
    status: 'UNAVAILABLE',
    generatedAt: now,
    candidateCount: 0,
    comparableCount: 0,
    analogs: [],
    outcomeSummary: summarize([]),
    policy:
      'Historical analogs are evidence only; GPT owns current market interpretation.',
  };
}

export async function buildTradingMemory(
  env: Env,
  snapshot: unknown,
  now = Date.now(),
): Promise<TradingMemoryContext> {
  const current = buildMarketFingerprint(snapshot);
  if (!env.DB || !current) return unavailable(now);

  const statement = env.DB.prepare(
    `SELECT
        f.decision_id AS decisionId,
        f.market_generated_at AS marketGeneratedAt,
        f.payload AS fingerprintPayload,
        d.decision AS decision,
        d.side AS side,
        d.confidence_band AS confidenceBand,
        o.return_bps_5m AS returnBps5m,
        o.max_up_bps_5m AS maxUpBps5m,
        o.max_down_bps_5m AS maxDownBps5m,
        o.return_bps_15m AS returnBps15m,
        o.max_up_bps_15m AS maxUpBps15m,
        o.max_down_bps_15m AS maxDownBps15m,
        o.return_bps_30m AS returnBps30m,
        o.max_up_bps_30m AS maxUpBps30m,
        o.max_down_bps_30m AS maxDownBps30m,
        o.return_bps_60m AS returnBps60m,
        o.max_up_bps_60m AS maxUpBps60m,
        o.max_down_bps_60m AS maxDownBps60m
       FROM decision_market_fingerprint f
       JOIN decision_log d ON d.decision_id = f.decision_id
       JOIN replay_case_outcomes o ON o.decision_id = f.decision_id
       WHERE o.finalized_at IS NOT NULL
         AND o.finalized_at <= ?
         AND f.market_generated_at < ?
         AND f.snapshot_id <> ?
       ORDER BY f.market_generated_at DESC
       LIMIT ?`,
  ).bind(
    current.marketGeneratedAt,
    current.marketGeneratedAt,
    current.snapshotId,
    MAX_CANDIDATES,
  ) as unknown as D1AllStatement;

  try {
    const queryResult = await statement.all<MemoryRow>();
    const rows = queryResult.results ?? [];
    const comparable: HistoricalAnalog[] = [];

    for (const row of rows) {
      const historical = parseFingerprint(row.fingerprintPayload);
      if (!historical) continue;
      const compared = similarity(current, historical);
      if (!compared) continue;
      comparable.push({
        decisionId: row.decisionId,
        marketGeneratedAt: row.marketGeneratedAt,
        similarity: compared.similarity,
        featureCoverage: compared.featureCoverage,
        overlappingFeatures: compared.overlappingFeatures,
        historicalDecision: row.decision,
        historicalSide: row.side,
        historicalConfidenceBand: row.confidenceBand,
        outcome: {
          '5m': outcome(row, '5m'),
          '15m': outcome(row, '15m'),
          '30m': outcome(row, '30m'),
          '60m': outcome(row, '60m'),
        },
      });
    }

    comparable.sort((a, b) => b.similarity - a.similarity);
    const analogs = comparable.slice(0, MAX_ANALOGS);
    return {
      version: TRADING_MEMORY_VERSION,
      status:
        analogs.length >= 3
          ? 'READY'
          : analogs.length > 0
            ? 'SPARSE'
            : 'NO_MATCH',
      generatedAt: now,
      candidateCount: rows.length,
      comparableCount: comparable.length,
      analogs,
      outcomeSummary: summarize(analogs),
      policy:
        'Historical analogs are evidence only; similarity and past outcomes are not a current LONG/SHORT signal.',
    };
  } catch {
    return unavailable(now);
  }
}
