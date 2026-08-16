import type { MarketSnapshot } from '../../../shared/contracts';
import {
  crossVenueIntelligenceSchema,
  type CoinbaseSpotObservation,
  type CrossVenueAsset,
  type CrossVenueIntelligence,
} from '../../../shared/cross-venue-intelligence';
import type { LeadAssetObservation } from '../../../shared/market-intelligence';

function difference(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null {
  return left === null ||
    left === undefined ||
    right === null ||
    right === undefined
    ? null
    : left - right;
}

function mid(observation: CoinbaseSpotObservation): number | null {
  if (observation.bidPrice !== null && observation.askPrice !== null)
    return (observation.bidPrice + observation.askPrice) / 2;
  return observation.lastPrice;
}

function referenceSpreadBps(
  perpMark: number | null,
  spotReference: number | null,
): number | null {
  if (perpMark === null || spotReference === null || spotReference <= 0)
    return null;
  return ((perpMark - spotReference) / spotReference) * 10_000;
}

function btcNormalizedDelta(
  snapshot: MarketSnapshot,
  window: '1m' | '5m',
): number | null {
  const buyRatio = snapshot.orderFlow[window].buyRatio;
  return buyRatio === null ? null : buyRatio * 2 - 1;
}

function assetRow(input: {
  asset: CrossVenueAsset;
  generatedAt: number;
  spot: CoinbaseSpotObservation | null;
  binanceInstrument: 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT';
  binanceMarkPrice: number | null;
  binanceReturns: {
    '1m': number | null;
    '3m': number | null;
    '5m': number | null;
  };
  binanceDelta1m: number | null;
  binanceDelta5m: number | null;
}): CrossVenueIntelligence['assets']['BTC'] {
  if (!input.spot) return null;
  const spotReference = mid(input.spot);
  const spotReturns = {
    '1m': input.spot.returnsBps['1m'],
    '3m': input.spot.returnsBps['3m'],
    '5m': input.spot.returnsBps['5m'],
  };
  const spotDelta1m = input.spot.flow['1m'].normalizedTakerDelta;
  const spotDelta5m = input.spot.flow['5m'].normalizedTakerDelta;
  return {
    asset: input.asset,
    generatedAt: input.generatedAt,
    coinbaseProductId: input.spot.productId,
    binanceInstrument: input.binanceInstrument,
    quoteCurrencyMismatch: true,
    coinbaseSpot: {
      lastPrice: input.spot.lastPrice,
      bidPrice: input.spot.bidPrice,
      askPrice: input.spot.askPrice,
      spreadBps: input.spot.spreadBps,
      returnsBps: spotReturns,
      normalizedTakerDelta1m: spotDelta1m,
      normalizedTakerDelta5m: spotDelta5m,
      depthImbalance20: input.spot.microstructure.depthImbalance20,
      microPrice: input.spot.microstructure.microPrice,
    },
    binancePerp: {
      markPrice: input.binanceMarkPrice,
      returnsBps: input.binanceReturns,
      normalizedTakerDelta1m: input.binanceDelta1m,
      normalizedTakerDelta5m: input.binanceDelta5m,
    },
    derived: {
      perpSpotReferenceSpreadBps: referenceSpreadBps(
        input.binanceMarkPrice,
        spotReference,
      ),
      returnDifferenceBps: {
        '1m': difference(input.binanceReturns['1m'], spotReturns['1m']),
        '3m': difference(input.binanceReturns['3m'], spotReturns['3m']),
        '5m': difference(input.binanceReturns['5m'], spotReturns['5m']),
      },
      normalizedTakerDeltaDifference1m: difference(
        input.binanceDelta1m,
        spotDelta1m,
      ),
      normalizedTakerDeltaDifference5m: difference(
        input.binanceDelta5m,
        spotDelta5m,
      ),
    },
  };
}

export function buildCrossVenueIntelligence(input: {
  snapshot: MarketSnapshot;
  lead: {
    ETHUSDT: LeadAssetObservation | null;
    SOLUSDT: LeadAssetObservation | null;
  };
  coinbase: {
    'BTC-USD': CoinbaseSpotObservation | null;
    'ETH-USD': CoinbaseSpotObservation | null;
    'SOL-USD': CoinbaseSpotObservation | null;
  };
}): CrossVenueIntelligence {
  const generatedAt = input.snapshot.generatedAt;
  const provenance = Object.values(input.coinbase)
    .flatMap((observation) => observation?.provenance ?? [])
    .sort((left, right) => right.collectorReceivedAt - left.collectorReceivedAt)
    .filter(
      (row, index, rows) =>
        rows.findIndex(
          (candidate) =>
            candidate.source === row.source &&
            candidate.instrument === row.instrument,
        ) === index,
    )
    .slice(0, 24);
  return crossVenueIntelligenceSchema.parse({
    version: 'cross-venue-v1',
    generatedAt,
    objectiveOnly: true,
    interpretationBoundary:
      'BINANCE_USDT_PERP_VS_COINBASE_USD_SPOT_REFERENCE_ONLY',
    assets: {
      BTC: assetRow({
        asset: 'BTC',
        generatedAt,
        spot: input.coinbase['BTC-USD'],
        binanceInstrument: 'BTCUSDT',
        binanceMarkPrice: input.snapshot.marketState.markPrice,
        binanceReturns: {
          '1m': input.snapshot.orderFlow['1m'].priceChangeBps,
          '3m': input.snapshot.orderFlow['3m'].priceChangeBps,
          '5m': input.snapshot.orderFlow['5m'].priceChangeBps,
        },
        binanceDelta1m: btcNormalizedDelta(input.snapshot, '1m'),
        binanceDelta5m: btcNormalizedDelta(input.snapshot, '5m'),
      }),
      ETH: assetRow({
        asset: 'ETH',
        generatedAt,
        spot: input.coinbase['ETH-USD'],
        binanceInstrument: 'ETHUSDT',
        binanceMarkPrice: input.lead.ETHUSDT?.market.markPrice ?? null,
        binanceReturns: {
          '1m': input.lead.ETHUSDT?.returnsBps['1m'] ?? null,
          '3m': input.lead.ETHUSDT?.returnsBps['3m'] ?? null,
          '5m': input.lead.ETHUSDT?.returnsBps['5m'] ?? null,
        },
        binanceDelta1m:
          input.lead.ETHUSDT?.tradeFlow['1m'].normalizedDelta ?? null,
        binanceDelta5m:
          input.lead.ETHUSDT?.tradeFlow['5m'].normalizedDelta ?? null,
      }),
      SOL: assetRow({
        asset: 'SOL',
        generatedAt,
        spot: input.coinbase['SOL-USD'],
        binanceInstrument: 'SOLUSDT',
        binanceMarkPrice: input.lead.SOLUSDT?.market.markPrice ?? null,
        binanceReturns: {
          '1m': input.lead.SOLUSDT?.returnsBps['1m'] ?? null,
          '3m': input.lead.SOLUSDT?.returnsBps['3m'] ?? null,
          '5m': input.lead.SOLUSDT?.returnsBps['5m'] ?? null,
        },
        binanceDelta1m:
          input.lead.SOLUSDT?.tradeFlow['1m'].normalizedDelta ?? null,
        binanceDelta5m:
          input.lead.SOLUSDT?.tradeFlow['5m'].normalizedDelta ?? null,
      }),
    },
    provenance,
  });
}
