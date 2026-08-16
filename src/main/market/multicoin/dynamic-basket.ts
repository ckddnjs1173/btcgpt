import {
  DYNAMIC_BASKET_VERSION,
  dynamicBasketCandidateSchema,
  dynamicBasketSchema,
  type DynamicBasket,
  type DynamicBasketCandidate,
  type DynamicBasketMember,
} from '../../../shared/alt-market-intelligence';

export const DYNAMIC_BASKET_TARGET_SIZE = 12;
export const DYNAMIC_BASKET_REBALANCE_MS = 15 * 60_000;
export const DYNAMIC_BASKET_MIN_RESIDENCE_MS = 60 * 60_000;
const ELECTIVE_REPLACEMENT_FRACTION = 0.25;
const REPLACEMENT_SCORE_MARGIN = 0.03;

const WEIGHTS = {
  quoteVolume: 0.4,
  openInterestNotional: 0.3,
  spreadQuality: 0.15,
  tradingActivity: 0.1,
  dataHealth: 0.05,
} as const;

function percentileMap(
  values: Array<{ symbol: string; value: number | null }>,
  higherIsBetter = true,
): Map<string, number> {
  const finite = values
    .filter(
      (row): row is { symbol: string; value: number } =>
        row.value !== null && Number.isFinite(row.value),
    )
    .sort((a, b) => {
      const valueOrder = a.value - b.value;
      return valueOrder !== 0 ? valueOrder : a.symbol.localeCompare(b.symbol);
    });
  const result = new Map<string, number>();
  if (finite.length === 0) return result;
  if (finite.length === 1) {
    result.set(finite[0]!.symbol, 1);
    return result;
  }

  let index = 0;
  while (index < finite.length) {
    let end = index;
    while (
      end + 1 < finite.length &&
      finite[end + 1]!.value === finite[index]!.value
    )
      end += 1;
    const averageRank = (index + end) / 2;
    const percentile = averageRank / (finite.length - 1);
    for (let i = index; i <= end; i += 1) {
      const row = finite[i]!;
      result.set(row.symbol, higherIsBetter ? percentile : 1 - percentile);
    }
    index = end + 1;
  }
  return result;
}

export function scoreDynamicBasketCandidates(
  candidates: DynamicBasketCandidate[],
): DynamicBasketMember[] {
  const rows = candidates.map((candidate) =>
    dynamicBasketCandidateSchema.parse(candidate),
  );
  const quoteVolume = percentileMap(
    rows.map((row) => ({ symbol: row.symbol, value: row.quoteVolume24h })),
  );
  const oi = percentileMap(
    rows.map((row) => ({
      symbol: row.symbol,
      value: row.openInterestNotional,
    })),
  );
  const spread = percentileMap(
    rows.map((row) => ({ symbol: row.symbol, value: row.spreadBps })),
    false,
  );
  const tradingActivity = percentileMap(
    rows.map((row) => ({ symbol: row.symbol, value: row.tradeCount24h })),
  );

  return rows
    .map((candidate) => {
      const components = {
        quoteVolumePercentile: quoteVolume.get(candidate.symbol) ?? 0,
        oiNotionalPercentile: oi.get(candidate.symbol) ?? 0,
        spreadQualityPercentile: spread.get(candidate.symbol) ?? 0,
        tradingActivityPercentile: tradingActivity.get(candidate.symbol) ?? 0,
        dataHealthPercentile: candidate.dataComplete ? 1 : 0,
      };
      const representativenessScore =
        components.quoteVolumePercentile * WEIGHTS.quoteVolume +
        components.oiNotionalPercentile * WEIGHTS.openInterestNotional +
        components.spreadQualityPercentile * WEIGHTS.spreadQuality +
        components.tradingActivityPercentile * WEIGHTS.tradingActivity +
        components.dataHealthPercentile * WEIGHTS.dataHealth;
      return {
        symbol: candidate.symbol,
        selectedAt: 0,
        representativenessScore,
        components,
      } satisfies DynamicBasketMember;
    })
    .sort((a, b) => {
      const scoreOrder = b.representativenessScore - a.representativenessScore;
      return scoreOrder !== 0 ? scoreOrder : a.symbol.localeCompare(b.symbol);
    });
}

export function selectDynamicBasket(input: {
  generatedAt: number;
  candidates: DynamicBasketCandidate[];
  previous?: DynamicBasket | null;
  targetSize?: number;
}): DynamicBasket {
  const targetSize = Math.max(
    1,
    Math.min(20, Math.trunc(input.targetSize ?? DYNAMIC_BASKET_TARGET_SIZE)),
  );
  const scored = scoreDynamicBasketCandidates(input.candidates);
  const scoreBySymbol = new Map(scored.map((row) => [row.symbol, row]));
  const previous = input.previous ?? null;

  if (!previous || previous.members.length === 0) {
    return dynamicBasketSchema.parse({
      version: DYNAMIC_BASKET_VERSION,
      generatedAt: input.generatedAt,
      rebalanceIntervalMs: DYNAMIC_BASKET_REBALANCE_MS,
      minimumResidenceMs: DYNAMIC_BASKET_MIN_RESIDENCE_MS,
      targetSize,
      eligibleCount: scored.length,
      members: scored.slice(0, targetSize).map((row) => ({
        ...row,
        selectedAt: input.generatedAt,
      })),
    });
  }

  const retained: DynamicBasketMember[] = [];
  for (const member of previous.members) {
    const refreshed = scoreBySymbol.get(member.symbol);
    if (!refreshed) continue;
    retained.push({ ...refreshed, selectedAt: member.selectedAt });
  }

  const selectedSymbols = new Set(retained.map((member) => member.symbol));
  for (const candidate of scored) {
    if (retained.length >= targetSize) break;
    if (selectedSymbols.has(candidate.symbol)) continue;
    retained.push({ ...candidate, selectedAt: input.generatedAt });
    selectedSymbols.add(candidate.symbol);
  }

  const maxElectiveReplacements = Math.max(
    1,
    Math.floor(targetSize * ELECTIVE_REPLACEMENT_FRACTION),
  );
  let replacements = 0;
  for (const challenger of scored) {
    if (replacements >= maxElectiveReplacements) break;
    if (selectedSymbols.has(challenger.symbol)) continue;
    const replaceable = retained
      .filter(
        (member) =>
          input.generatedAt - member.selectedAt >=
          DYNAMIC_BASKET_MIN_RESIDENCE_MS,
      )
      .sort((a, b) => {
        const scoreOrder =
          a.representativenessScore - b.representativenessScore;
        return scoreOrder !== 0 ? scoreOrder : b.symbol.localeCompare(a.symbol);
      })[0];
    if (!replaceable) break;
    if (
      challenger.representativenessScore <
      replaceable.representativenessScore + REPLACEMENT_SCORE_MARGIN
    )
      continue;
    const index = retained.findIndex(
      (member) => member.symbol === replaceable.symbol,
    );
    if (index < 0) continue;
    retained[index] = { ...challenger, selectedAt: input.generatedAt };
    selectedSymbols.delete(replaceable.symbol);
    selectedSymbols.add(challenger.symbol);
    replacements += 1;
  }

  retained.sort((a, b) => {
    const scoreOrder = b.representativenessScore - a.representativenessScore;
    return scoreOrder !== 0 ? scoreOrder : a.symbol.localeCompare(b.symbol);
  });

  return dynamicBasketSchema.parse({
    version: DYNAMIC_BASKET_VERSION,
    generatedAt: input.generatedAt,
    rebalanceIntervalMs: DYNAMIC_BASKET_REBALANCE_MS,
    minimumResidenceMs: DYNAMIC_BASKET_MIN_RESIDENCE_MS,
    targetSize,
    eligibleCount: scored.length,
    members: retained.slice(0, targetSize),
  });
}
