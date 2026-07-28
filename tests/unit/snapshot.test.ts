import { describe, it, expect } from 'vitest';
import { generateSnapshot } from '../../src/main/market/snapshot';
import { MarketCache } from '../../src/main/market/cache';
import { TIMEFRAMES } from '../../src/main/market/types';

describe('snapshot generator', () => {
  it('builds a normalized snapshot from closed candles', () => {
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
    cache.updateDepth([[30_049, 2]], [[30_051, 2]], now, now);
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
    const snap = generateSnapshot(cache, { serverTime: now });

    expect(snap.symbol).toBe('BTCUSDT');
    expect(snap.timeframes['5m'].closed).toHaveLength(120);
    expect(snap.marketState.markPrice).toBe(30_050);
    expect(snap.analysisGate.analysisAllowed).toBe(true);
    expect(snap.timeframes['5m'].indicators.ema200).not.toBeNull();
    expect(snap.account).not.toHaveProperty('walletBalance');
    expect(JSON.stringify(snap).length).toBeLessThan(90_000);
  });
});
