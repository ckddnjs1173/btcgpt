import {
  ALT_MARKET_VERSION,
  altMarketIntelligenceSchema,
  type AltAssetObservation,
  type AltMarketIntelligence,
  type DynamicBasket,
  type DynamicBasketCandidate,
} from '../../../shared/alt-market-intelligence';
import type { EvidenceHealth } from '../../../shared/market-intelligence';

const RETURN_WINDOWS = ['1m', '3m', '5m', '15m', '1h'] as const;
const FLOW_WINDOWS = ['1m', '5m', '15m'] as const;
type ReturnWindow = (typeof RETURN_WINDOWS)[number];

function sortedFinite(values: Array<number | null>): number[] {
  return values
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    )
    .sort((a, b) => a - b);
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0]!;
  const position = Math.max(0, Math.min(1, fraction)) * (values.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return values[lower]! * (1 - weight) + values[upper]! * weight;
}

function median(values: Array<number | null>): number | null {
  return percentile(sortedFinite(values), 0.5);
}

function trimmedMean(values: number[]): number | null {
  if (values.length === 0) return null;
  const trim = values.length >= 10 ? Math.floor(values.length * 0.1) : 0;
  const selected = values.slice(trim, Math.max(trim + 1, values.length - trim));
  return selected.reduce((sum, value) => sum + value, 0) / selected.length;
}

function directional(values: Array<number | null>, neutralBand = 1e-12) {
  const finite = sortedFinite(values);
  return {
    validCount: finite.length,
    positive: finite.filter((value) => value > neutralBand).length,
    negative: finite.filter((value) => value < -neutralBand).length,
    neutral: finite.filter((value) => Math.abs(value) <= neutralBand).length,
    median: percentile(finite, 0.5),
  };
}

function priceBreadth(
  observations: AltAssetObservation[],
  window: ReturnWindow,
  quoteVolumeBySymbol: Map<string, number>,
) {
  const rows = observations
    .map((observation) => ({
      symbol: observation.symbol,
      value: observation.returnsBps[window],
      weight: quoteVolumeBySymbol.get(observation.symbol) ?? 0,
    }))
    .filter(
      (row): row is { symbol: string; value: number; weight: number } =>
        row.value !== null && Number.isFinite(row.value),
    );
  const values = rows.map((row) => row.value).sort((a, b) => a - b);
  const totalWeight = rows.reduce(
    (sum, row) =>
      sum + (Number.isFinite(row.weight) ? Math.max(0, row.weight) : 0),
    0,
  );
  return {
    validCount: values.length,
    advancers: values.filter((value) => value > 0).length,
    decliners: values.filter((value) => value < 0).length,
    unchanged: values.filter((value) => value === 0).length,
    medianReturnBps: percentile(values, 0.5),
    trimmedMeanReturnBps: trimmedMean(values),
    p25ReturnBps: percentile(values, 0.25),
    p75ReturnBps: percentile(values, 0.75),
    dispersionIqrBps:
      values.length > 0
        ? (percentile(values, 0.75) ?? 0) - (percentile(values, 0.25) ?? 0)
        : null,
    liquidityWeightedReturnBps:
      totalWeight > 0
        ? rows.reduce(
            (sum, row) => sum + row.value * Math.max(0, row.weight),
            0,
          ) / totalWeight
        : null,
  };
}

function liquidationBreadth(
  observations: AltAssetObservation[],
  window: '5m' | '15m',
) {
  const rows = observations.map(
    (observation) => observation.liquidations[window],
  );
  return {
    validCount: rows.length,
    symbolsWithObservedLongLiquidation: rows.filter(
      (row) => row.observedLongNotional > 0,
    ).length,
    symbolsWithObservedShortLiquidation: rows.filter(
      (row) => row.observedShortNotional > 0,
    ).length,
    observedLongNotional: rows.reduce(
      (sum, row) => sum + row.observedLongNotional,
      0,
    ),
    observedShortNotional: rows.reduce(
      (sum, row) => sum + row.observedShortNotional,
      0,
    ),
    coverage: 'SNAPSHOT' as const,
  };
}

function rotation(observations: AltAssetObservation[]) {
  const rows = observations
    .map((observation) => {
      const currentNotional = observation.openInterest.notional;
      const changePercent = observation.openInterest.changesPercent['5m'];
      if (
        currentNotional === null ||
        changePercent === null ||
        !Number.isFinite(currentNotional) ||
        !Number.isFinite(changePercent) ||
        1 + changePercent / 100 <= 0
      )
        return null;
      const previousNotional = currentNotional / (1 + changePercent / 100);
      return {
        symbol: observation.symbol,
        changePercent,
        currentNotional,
        previousNotional,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const currentTotal = rows.reduce((sum, row) => sum + row.currentNotional, 0);
  const previousTotal = rows.reduce(
    (sum, row) => sum + row.previousNotional,
    0,
  );
  const byChange = [...rows].sort((a, b) => {
    const changeOrder = b.changePercent - a.changePercent;
    return changeOrder !== 0 ? changeOrder : a.symbol.localeCompare(b.symbol);
  });
  return {
    aggregateOiNotionalChangePercent:
      previousTotal > 0
        ? ((currentTotal - previousTotal) / previousTotal) * 100
        : null,
    topOiIncreaseSymbols: byChange.slice(0, 3).map((row) => row.symbol),
    topOiDecreaseSymbols: byChange
      .slice(-3)
      .reverse()
      .map((row) => row.symbol),
  };
}

export function buildAltMarketIntelligence(input: {
  generatedAt: number;
  basket: DynamicBasket;
  sentimentCore: AltAssetObservation[];
  dynamic: AltAssetObservation[];
  candidates?: DynamicBasketCandidate[];
  btcReturnsBps?: Partial<Record<ReturnWindow, number | null>>;
  evidenceHealth?: EvidenceHealth[];
}): AltMarketIntelligence {
  const quoteVolumeBySymbol = new Map(
    (input.candidates ?? []).map((candidate) => [
      candidate.symbol,
      candidate.quoteVolume24h,
    ]),
  );
  const btcReturns = input.btcReturnsBps ?? {};
  const dynamicMedian = Object.fromEntries(
    RETURN_WINDOWS.map((window) => [
      window,
      median(
        input.dynamic.map((observation) => observation.returnsBps[window]),
      ),
    ]),
  ) as Record<ReturnWindow, number | null>;
  const differences5m = input.dynamic
    .flatMap((observation) => {
      const lead = observation.returnsBps['5m'];
      const btc = btcReturns['5m'];
      return lead === null || btc === null || btc === undefined
        ? []
        : [{ symbol: observation.symbol, differenceBps: lead - btc }];
    })
    .sort((a, b) => {
      const differenceOrder = b.differenceBps - a.differenceBps;
      return differenceOrder !== 0
        ? differenceOrder
        : a.symbol.localeCompare(b.symbol);
    });
  const provenance = [...input.sentimentCore, ...input.dynamic]
    .flatMap((observation) => observation.provenance)
    .sort((a, b) => b.collectorReceivedAt - a.collectorReceivedAt)
    .filter(
      (row, index, rows) =>
        rows.findIndex(
          (candidate) =>
            candidate.source === row.source &&
            candidate.instrument === row.instrument,
        ) === index,
    )
    .slice(0, 64);

  return altMarketIntelligenceSchema.parse({
    version: ALT_MARKET_VERSION,
    generatedAt: input.generatedAt,
    objectiveOnly: true,
    basket: input.basket,
    sentimentCore: input.sentimentCore,
    dynamic: input.dynamic,
    breadth: {
      price: Object.fromEntries(
        RETURN_WINDOWS.map((window) => [
          window,
          priceBreadth(input.dynamic, window, quoteVolumeBySymbol),
        ]),
      ),
      delta: Object.fromEntries(
        FLOW_WINDOWS.map((window) => [
          window,
          directional(
            input.dynamic.map(
              (observation) => observation.flow[window].normalizedDelta,
            ),
          ),
        ]),
      ),
      openInterest: Object.fromEntries(
        FLOW_WINDOWS.map((window) => [
          window,
          directional(
            input.dynamic.map(
              (observation) => observation.openInterest.changesPercent[window],
            ),
          ),
        ]),
      ),
      funding: directional(
        input.dynamic.map((observation) => observation.market.fundingRate),
      ),
      volumeAcceleration1m: directional(
        input.dynamic.map(
          (observation) => observation.flow.volumeAcceleration1m,
        ),
      ),
      liquidations: {
        '5m': liquidationBreadth(input.dynamic, '5m'),
        '15m': liquidationBreadth(input.dynamic, '15m'),
      },
    },
    relativeStrength: {
      altMedianMinusBtcBps: Object.fromEntries(
        RETURN_WINDOWS.map((window) => {
          const alt = dynamicMedian[window];
          const btc = btcReturns[window];
          return [
            window,
            alt === null || btc === null || btc === undefined
              ? null
              : alt - btc,
          ];
        }),
      ),
      strongestVsBtc: differences5m.slice(0, 3),
      weakestVsBtc: differences5m.slice(-3).reverse(),
    },
    rotation: rotation(input.dynamic),
    evidenceHealth: input.evidenceHealth ?? [],
    provenance,
  });
}
