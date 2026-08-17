import { aggregateEvalV2PathQuality } from './eval-v2-path-summary';

type UnknownRecord = Record<string, unknown>;

export type ResearchDecisionRow = {
  decisionId: string;
  scorePayload: string | null;
  snapshotPayload: string | null;
};

type DecisionClass =
  | 'ENTER'
  | 'WAIT'
  | 'ABSTAIN'
  | 'DATA_BLOCKED'
  | 'POSITION_MANAGEMENT'
  | 'UNKNOWN';

type DecisionCounts = Record<DecisionClass, number>;

type ParsedResearchRow = ResearchDecisionRow & {
  score: UnknownRecord;
  decisionClass: DecisionClass;
  snapshot: UnknownRecord | null;
  completenessCohort: 'FULL_CORE' | 'PARTIAL_CORE' | 'LEGACY_INPUT';
  btc15mRealizedVolatility: number | null;
  btc1hReturn12Sign: 'POSITIVE' | 'NEGATIVE' | 'ZERO' | 'UNAVAILABLE';
  volatilityBand:
    'LOW_RELATIVE' | 'MID_RELATIVE' | 'HIGH_RELATIVE' | 'UNAVAILABLE';
};

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parseJson(raw: string | null): UnknownRecord | null {
  if (!raw) return null;
  try {
    return record(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function at(root: UnknownRecord | null, ...path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const currentRecord = record(current);
    if (!currentRecord) return undefined;
    current = currentRecord[key];
  }
  return current;
}

function normalizedDecisionClass(value: unknown): DecisionClass {
  return value === 'ENTER' ||
    value === 'WAIT' ||
    value === 'ABSTAIN' ||
    value === 'DATA_BLOCKED' ||
    value === 'POSITION_MANAGEMENT'
    ? value
    : 'UNKNOWN';
}

function emptyDecisionCounts(): DecisionCounts {
  return {
    ENTER: 0,
    WAIT: 0,
    ABSTAIN: 0,
    DATA_BLOCKED: 0,
    POSITION_MANAGEMENT: 0,
    UNKNOWN: 0,
  };
}

function decisionMix(rows: ParsedResearchRow[]) {
  const counts = emptyDecisionCounts();
  for (const row of rows) counts[row.decisionClass] += 1;
  const denominator = rows.length;
  return {
    samples: denominator,
    counts,
    rates: Object.fromEntries(
      Object.entries(counts).map(([key, value]) => [
        key,
        denominator === 0 ? null : value / denominator,
      ]),
    ) as Record<DecisionClass, number | null>,
  };
}

function completenessCohort(snapshot: UnknownRecord | null) {
  if (snapshot?.version !== 'decision-context-v1')
    return 'LEGACY_INPUT' as const;
  const completeness = record(snapshot.completeness);
  const cryptoMarketAvailable = bool(completeness?.cryptoMarketAvailable);
  const leadAssetsAvailable = finite(completeness?.leadAssetsAvailable);
  const dynamicAssetCount = finite(completeness?.dynamicAssetCount);
  const crossMarket = finite(completeness?.crossMarket);
  const externalAvailable = bool(completeness?.externalAvailable);
  return cryptoMarketAvailable === true &&
    leadAssetsAvailable === 2 &&
    dynamicAssetCount !== null &&
    dynamicAssetCount > 0 &&
    crossMarket !== null &&
    crossMarket > 0 &&
    externalAvailable === true
    ? ('FULL_CORE' as const)
    : ('PARTIAL_CORE' as const);
}

function returnSign(value: number | null) {
  if (value === null) return 'UNAVAILABLE' as const;
  if (value > 0) return 'POSITIVE' as const;
  if (value < 0) return 'NEGATIVE' as const;
  return 'ZERO' as const;
}

function percentile(sorted: number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = sorted[lower] ?? sorted[0] ?? 0;
  const high = sorted[upper] ?? sorted.at(-1) ?? low;
  if (lower === upper) return low;
  const weight = index - lower;
  return low * (1 - weight) + high * weight;
}

function volatilityThresholds(rows: ParsedResearchRow[]) {
  const byDecision = new Map<string, number>();
  for (const row of rows) {
    if (row.btc15mRealizedVolatility === null) continue;
    if (!byDecision.has(row.decisionId)) {
      byDecision.set(row.decisionId, row.btc15mRealizedVolatility);
    }
  }
  const values = [...byDecision.values()].sort((a, b) => a - b);
  if (values.length < 3) {
    return {
      caseSamples: values.length,
      lowerTercile: null,
      upperTercile: null,
    };
  }
  return {
    caseSamples: values.length,
    lowerTercile: percentile(values, 1 / 3),
    upperTercile: percentile(values, 2 / 3),
  };
}

function volatilityBand(
  value: number | null,
  thresholds: ReturnType<typeof volatilityThresholds>,
) {
  if (
    value === null ||
    thresholds.lowerTercile === null ||
    thresholds.upperTercile === null
  ) {
    return 'UNAVAILABLE' as const;
  }
  if (thresholds.lowerTercile === thresholds.upperTercile) {
    return 'MID_RELATIVE' as const;
  }
  if (value <= thresholds.lowerTercile) return 'LOW_RELATIVE' as const;
  if (value >= thresholds.upperTercile) return 'HIGH_RELATIVE' as const;
  return 'MID_RELATIVE' as const;
}

function groupSummary(rows: ParsedResearchRow[]) {
  const pathQuality = aggregateEvalV2PathQuality(
    rows.map((row) => ({
      decisionId: row.decisionId,
      scorePayload: row.scorePayload,
    })),
  );
  return {
    runCount: rows.length,
    decisionCount: new Set(rows.map((row) => row.decisionId)).size,
    decisionMix: decisionMix(rows),
    pathQuality: {
      enter: pathQuality.enter,
      wait: pathQuality.wait,
      management: pathQuality.management,
    },
  };
}

function grouped(
  rows: ParsedResearchRow[],
  keyOf: (row: ParsedResearchRow) => string,
) {
  const groups = new Map<string, ParsedResearchRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }
  return [...groups.entries()]
    .map(([cohort, cohortRows]) => ({ cohort, ...groupSummary(cohortRows) }))
    .sort((left, right) =>
      right.runCount !== left.runCount
        ? right.runCount - left.runCount
        : left.cohort.localeCompare(right.cohort),
    );
}

export function aggregateResearchDecisionCohorts(rows: ResearchDecisionRow[]) {
  const parsed: ParsedResearchRow[] = [];
  let invalidScorePayloads = 0;
  let nonEvalV2Scores = 0;
  let invalidSnapshotPayloads = 0;

  for (const row of rows) {
    const score = parseJson(row.scorePayload);
    if (!score) {
      invalidScorePayloads += 1;
      continue;
    }
    if (score.evaluatorVersion !== 'eval-v2') {
      nonEvalV2Scores += 1;
      continue;
    }
    const snapshot = parseJson(row.snapshotPayload);
    if (!snapshot) invalidSnapshotPayloads += 1;
    const volatility = finite(
      at(snapshot, 'btcCore', 'timeframes', '15m', 'realizedVolatility'),
    );
    const oneHourReturn12 = finite(
      at(snapshot, 'btcCore', 'timeframes', '1h', 'return12'),
    );
    parsed.push({
      ...row,
      score,
      decisionClass: normalizedDecisionClass(score.decisionClass),
      snapshot,
      completenessCohort: completenessCohort(snapshot),
      btc15mRealizedVolatility: volatility,
      btc1hReturn12Sign: returnSign(oneHourReturn12),
      volatilityBand: 'UNAVAILABLE',
    });
  }

  const thresholds = volatilityThresholds(parsed);
  for (const row of parsed) {
    row.volatilityBand = volatilityBand(
      row.btc15mRealizedVolatility,
      thresholds,
    );
  }

  const decisionContextRows = parsed.filter(
    (row) => row.snapshot?.version === 'decision-context-v1',
  ).length;
  const completenessCohorts = grouped(parsed, (row) => row.completenessCohort);
  const regimeCohorts = grouped(
    parsed,
    (row) => `${row.volatilityBand}|BTC_1H_RETURN12_${row.btc1hReturn12Sign}`,
  );

  return {
    version: 'research-decision-cohorts-v1',
    rows: {
      total: rows.length,
      parsedEvalV2Scores: parsed.length,
      invalidScorePayloads,
      nonEvalV2Scores,
      invalidSnapshotPayloads,
      decisionContextRows,
      legacyOrUnknownContextRows: parsed.length - decisionContextRows,
    },
    decisionMix: decisionMix(parsed),
    regimeDefinition: {
      volatilityFeature: 'btcCore.timeframes.15m.realizedVolatility',
      volatilityMethod: 'EMPIRICAL_TERCILES_OVER_DISTINCT_FROZEN_CASES',
      lowerTercile: thresholds.lowerTercile,
      upperTercile: thresholds.upperTercile,
      thresholdCaseSamples: thresholds.caseSamples,
      returnFeature: 'btcCore.timeframes.1h.return12',
      returnMethod: 'SIGN_ONLY_DESCRIPTIVE_BUCKET',
    },
    completenessDefinition: {
      FULL_CORE:
        'decision-context-v1 with crypto market, both ETH/SOL lead assets, at least one dynamic alt asset, positive cross-market completeness and external context available',
      PARTIAL_CORE:
        'decision-context-v1 that does not satisfy every FULL_CORE availability condition',
      LEGACY_INPUT: 'input is not decision-context-v1 or could not be parsed',
      candidateAxesExcludedFromFullCoreRequirement: ['optionsV2', 'onchainV1'],
    },
    completenessCohorts,
    regimeCohorts,
    policy: {
      tradingSignal: false,
      automaticPromotion: false,
      scalarWinnerScore: false,
      note: 'Cohorts are descriptive stratifications of frozen inputs. Relative volatility bands are empirical terciles within the same frozen case set; return sign is not a LONG/SHORT signal. Compare matched profiles within the same cohort and preserve sample counts.',
    },
  };
}
