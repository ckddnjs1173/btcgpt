import { describe, expect, it } from 'vitest';

import type { MarketSnapshot } from '../../src/shared/contracts';
import { coinbaseSpotObservationSchema } from '../../src/shared/cross-venue-intelligence';
import { buildCrossVenueIntelligence } from '../../src/main/market/intelligence/cross-venue';

function coinbaseBtc() {
  return coinbaseSpotObservationSchema.parse({
    productId: 'BTC-USD',
    asset: 'BTC',
    venue: 'COINBASE_SPOT',
    quoteAsset: 'USD',
    generatedAt: 1_000,
    lastPrice: 100,
    bidPrice: 99.9,
    askPrice: 100.1,
    spreadBps: 20,
    returnsBps: {
      '15s': 10,
      '30s': 20,
      '1m': 80,
      '3m': 90,
      '5m': 100,
      '15m': 120,
    },
    flow: Object.fromEntries(
      ['15s', '30s', '1m', '3m', '5m'].map((window) => [
        window,
        {
          tradeCount: 2,
          aggressiveBuyNotional: 600,
          aggressiveSellNotional: 400,
          normalizedTakerDelta: 0.2,
          aggressiveBuyRatio: 0.6,
        },
      ]),
    ),
    microstructure: {
      bookSynchronized: true,
      bidNotional20: 10_000,
      askNotional20: 9_000,
      depthImbalance20: 1_000 / 19_000,
      microPrice: 100.01,
      level2ObservedAt: 990,
    },
    connection: {
      connected: true,
      lastMessageAt: 995,
      lastHeartbeatAt: 995,
      reconnectCount: 0,
      sequenceGapCount: 0,
    },
    provenance: [],
  });
}

describe('cross-venue intelligence', () => {
  it('derives reference-only BTC spot/perp differences without a trading signal', () => {
    const snapshot = {
      generatedAt: 1_000,
      marketState: { markPrice: 101 },
      orderFlow: {
        '1m': { priceChangeBps: 100, buyRatio: 0.65 },
        '3m': { priceChangeBps: 120, buyRatio: 0.6 },
        '5m': { priceChangeBps: 140, buyRatio: 0.7 },
      },
    } as unknown as MarketSnapshot;

    const result = buildCrossVenueIntelligence({
      snapshot,
      lead: { ETHUSDT: null, SOLUSDT: null },
      coinbase: {
        'BTC-USD': coinbaseBtc(),
        'ETH-USD': null,
        'SOL-USD': null,
      },
    });

    expect(result.version).toBe('cross-venue-v1');
    expect(result.objectiveOnly).toBe(true);
    expect(result.interpretationBoundary).toBe(
      'BINANCE_USDT_PERP_VS_COINBASE_USD_SPOT_REFERENCE_ONLY',
    );
    expect(result.assets.BTC?.quoteCurrencyMismatch).toBe(true);
    expect(result.assets.BTC?.derived.perpSpotReferenceSpreadBps).toBeCloseTo(
      100,
    );
    expect(result.assets.BTC?.derived).not.toHaveProperty('arbitrageSpreadBps');
    expect(result.assets.BTC?.derived.returnDifferenceBps['1m']).toBeCloseTo(
      20,
    );
    expect(
      result.assets.BTC?.derived.normalizedTakerDeltaDifference1m,
    ).toBeCloseTo(0.1);
    expect(result.assets.ETH).toBeNull();
    expect(result.assets.SOL).toBeNull();
    expect(result).not.toHaveProperty('signal');
    expect(result).not.toHaveProperty('recommendedSide');
    expect(JSON.stringify(result)).not.toMatch(
      /longSignal|shortSignal|buySignal|sellSignal|bullishScore|bearishScore/i,
    );
  });
});
