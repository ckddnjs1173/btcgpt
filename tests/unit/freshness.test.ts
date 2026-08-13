import { describe, expect, it } from 'vitest';

import { MarketCache } from '../../src/main/market/cache';

describe('PROJECT_SPEC freshness thresholds', () => {
  it('uses the specified market, depth, trade, and candle boundaries', () => {
    const cache = new MarketCache();
    const receivedAt = 1_000_000;
    cache.setConnected(true);
    cache.updateState({ markPrice: 60_000 }, receivedAt, 'market');
    cache.updateDepth([], [], receivedAt, receivedAt);
    cache.updateState({}, receivedAt, 'bookTicker', receivedAt);
    cache.addTrade({
      eventTime: receivedAt,
      receivedAt,
      price: 60_000,
      quantity: 0.1,
      buyerIsMaker: false,
    });
    cache.upsertCandle({
      symbol: 'BTCUSDT',
      timeframe: '5m',
      openTime: 0,
      closeTime: 1,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      quoteVolume: 1,
      tradeCount: 1,
      takerBuyBaseVolume: 1,
      takerBuyQuoteVolume: 1,
      isClosed: false,
      eventTime: receivedAt,
      receivedAt,
    });

    expect(cache.sourceHealth(receivedAt + 2_001).market!.status).toBe(
      'DELAYED',
    );
    expect(cache.sourceHealth(receivedAt + 5_001).market!.status).toBe('STALE');
    expect(cache.sourceHealth(receivedAt + 3_001).depth!.status).toBe('STALE');
    expect(cache.sourceHealth(receivedAt + 3_001).trades!.status).toBe(
      'DELAYED',
    );
    expect(cache.sourceHealth(receivedAt + 10_001).trades!.status).toBe(
      'STALE',
    );
    expect(cache.sourceHealth(receivedAt + 20_001)['candle:5m']!.status).toBe(
      'DELAYED',
    );
    expect(cache.sourceHealth(receivedAt + 45_001)['candle:5m']!.status).toBe(
      'STALE',
    );
  });
});
