import { describe, expect, it } from 'vitest';

import { createCompactRelaySnapshot } from '../../src/main/market/compact-snapshot';
import { MarketCache } from '../../src/main/market/cache';
import { generateSnapshot } from '../../src/main/market/snapshot';
import { TIMEFRAMES } from '../../src/main/market/types';

describe('snapshot generator', () => {
  it('builds a normalized full snapshot and a relay-safe compact snapshot', () => {
    const cache = new MarketCache();
    const now = Date.now();
    for (const timeframe of TIMEFRAMES) {
      for (let index = 0; index < 250; index += 1) {
        cache.upsertCandle({
          symbol: 'BTCUSDT',
          timeframe,
          openTime: index,
          closeTime: index + 1,
          open: 30_000,
          high: 30_100,
          low: 29_900,
          close: 30_050,
          volume: 12,
          quoteVolume: 360_000,
          tradeCount: 10,
          takerBuyBaseVolume: 6,
          takerBuyQuoteVolume: 180_000,
          isClosed: true,
          eventTime: now,
          receivedAt: now,
        });
      }
    }
    cache.setConnected(true);
    cache.updateState(
      {
        lastPrice: 30_050,
        markPrice: 30_050,
        indexPrice: 30_045,
        bidPrice: 30_049,
        askPrice: 30_051,
      },
      now,
    );
    cache.updateState({ openInterest: 1_000 }, now, 'openInterest', now);
    cache.updateDepth([[30_049, 2]], [[30_051, 2]], now, now, {
      synchronized: true,
      lastUpdateId: 1,
      levelCount: 1,
    });
    cache.updateState({}, now, 'bookTicker', now);
    cache.setProductFilters({
      tickSize: 0.1,
      stepSize: 0.001,
      minQuantity: 0.001,
      minNotional: 5,
      updatedAt: now,
    });
    cache.addTrade({
      eventTime: now,
      receivedAt: now,
      price: 30_050,
      quantity: 0.1,
      buyerIsMaker: false,
    });
    const snapshot = generateSnapshot(cache, { serverTime: now });
    const compact = createCompactRelaySnapshot(snapshot);

    expect(snapshot.symbol).toBe('BTCUSDT');
    expect(snapshot.timeframes['5m'].closed).toHaveLength(120);
    expect(snapshot.marketState.markPrice).toBe(30_050);
    expect(snapshot.analysisGate.analysisAllowed).toBe(true);
    expect(snapshot.decisionGates.marketAnalysisAvailable).toBe(true);
    expect(snapshot.orderFlow.orderBookSynchronized).toBe(true);
    expect(snapshot.timeframes['5m'].indicators.ema200).not.toBeNull();
    expect(snapshot.account).not.toHaveProperty('walletBalance');
    expect(compact.byteLength).toBeLessThan(89_000);
  });
});
