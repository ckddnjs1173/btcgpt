import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KlineTuple } from '../../src/main/binance/schemas';
import { MarketCache } from '../../src/main/market/cache';
import { detectCandleGaps } from '../../src/main/market/gaps';
import { MarketDataService } from '../../src/main/market/service';
import type { Candle } from '../../src/main/market/types';

const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), 'tests/fixtures/binance-ws.json'),
    'utf8',
  ),
) as Record<string, unknown>;

const repository = {
  readClosedCandles: () => [] as Candle[],
  upsertClosedCandle: () => undefined,
};

describe('recorded Binance public stream integration', () => {
  it('normalizes trades and candles without exposing an unsynchronized diff book', () => {
    const service = new MarketDataService(repository);
    const receivedAt = 1_700_000_000_500;
    for (const fixture of Object.values(fixtures))
      service.ingestRecordedMessage(JSON.stringify(fixture), receivedAt);

    expect(service.cache.getTrades(60_000, receivedAt)).toHaveLength(1);
    expect(service.cache.depth.synchronized).toBe(false);
    expect(service.cache.depth.bids).toHaveLength(0);
    expect(service.cache.getLiquidations(60_000, receivedAt)[0]?.notional).toBe(
      29_997.5,
    );
    expect(service.cache.getClosed('5m')).toHaveLength(1);
    expect(service.cache.getLive('5m')).toBeNull();
  });

  it('rejects malformed numeric strings instead of normalizing them', () => {
    const service = new MarketDataService(repository);
    const malformed = structuredClone(fixtures.aggTrade) as {
      data: { p: string };
    };
    malformed.data.p = 'NaN';
    expect(() =>
      service.ingestRecordedMessage(JSON.stringify(malformed)),
    ).toThrow();
  });
});

describe('candle gaps and source freshness', () => {
  const candle = (openTime: number): Candle => ({
    symbol: 'BTCUSDT',
    timeframe: '5m',
    openTime,
    closeTime: openTime + 299_999,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    quoteVolume: 1,
    tradeCount: 1,
    takerBuyBaseVolume: 0.5,
    takerBuyQuoteVolume: 0.5,
    isClosed: true,
    eventTime: openTime + 299_999,
    receivedAt: openTime + 300_000,
  });

  it('detects exact missing open times', () => {
    expect(detectCandleGaps([candle(0), candle(600_000)], '5m')).toEqual([
      300_000,
    ]);
  });

  it('does not report stale sources as normal', () => {
    const cache = new MarketCache();
    cache.setConnected(true);
    cache.updateDepth([[1, 1]], [[2, 1]], 1_000, 1_000);
    expect(cache.sourceHealth(5_000).depth?.status).toBe('STALE');
  });
});

describe('disconnect, reconnect, and REST recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('starts both stream channels and reconnects a failed channel while recovery runs', async () => {
    vi.useFakeTimers();
    class FakeSocket {
      readonly listeners = new Map<string, Array<() => void>>();
      addEventListener(type: string, listener: () => void) {
        this.listeners.set(type, [
          ...(this.listeners.get(type) ?? []),
          listener,
        ]);
      }
      close() {
        this.emit('close');
      }
      emit(type: string) {
        for (const listener of this.listeners.get(type) ?? []) listener();
      }
    }

    const sockets: FakeSocket[] = [];
    const intervalMs: Record<string, number> = {
      '1m': 60_000,
      '3m': 180_000,
      '5m': 300_000,
      '15m': 900_000,
      '30m': 1_800_000,
      '1h': 3_600_000,
      '4h': 14_400_000,
      '1d': 86_400_000,
      '1w': 604_800_000,
    };
    const fetchKlines = vi.fn((_symbol: 'BTCUSDT', timeframe: string) => {
      const interval = intervalMs[timeframe] ?? 60_000;
      return Promise.resolve(
        Array.from({ length: 251 }, (_, index) => {
          const open = index * interval;
          return [
            open,
            '60000',
            '60100',
            '59900',
            '60050',
            '10',
            open + interval - 1,
            '600000',
            100,
            '6',
            '360000',
            '0',
          ] as KlineTuple;
        }),
      );
    });
    const dependencies = {
      fetchServerTime: () => Promise.resolve({ serverTime: Date.now() }),
      fetchExchangeInfo: () =>
        Promise.resolve({
          serverTime: Date.now(),
          symbols: [
            {
              symbol: 'BTCUSDT',
              contractType: 'PERPETUAL',
              status: 'TRADING',
              filters: [
                { filterType: 'PRICE_FILTER', tickSize: '0.1' },
                {
                  filterType: 'LOT_SIZE',
                  minQty: '0.001',
                  stepSize: '0.001',
                },
                { filterType: 'MIN_NOTIONAL', notional: '5' },
              ],
            },
          ],
        }),
      fetchKlines,
      fetchMarkPrice: () =>
        Promise.resolve({
          symbol: 'BTCUSDT' as const,
          markPrice: '60050',
          indexPrice: '60040',
          lastFundingRate: '0.0001',
          nextFundingTime: Date.now() + 1_000,
        }),
      fetchTicker24h: () =>
        Promise.resolve({
          symbol: 'BTCUSDT' as const,
          priceChangePercent: '1',
          weightedAvgPrice: '60000',
          prevClosePrice: '59000',
          lastPrice: '60050',
          lastQty: '0.1',
          bidPrice: '60049',
          askPrice: '60051',
          openPrice: '59000',
          highPrice: '61000',
          lowPrice: '58000',
          volume: '1000',
          quoteVolume: '60000000',
        }),
      fetchOpenInterest: () =>
        Promise.resolve({
          symbol: 'BTCUSDT' as const,
          openInterest: '1000',
          time: Date.now(),
        }),
      fetchOrderBook: () =>
        Promise.resolve({
          lastUpdateId: 1,
          E: Date.now(),
          T: Date.now(),
          bids: [['60049', '1']] as Array<[string, string]>,
          asks: [['60051', '1']] as Array<[string, string]>,
        }),
      fetchAggregateTrades: () => Promise.resolve([]),
      fetchRatioHistory: () =>
        Promise.resolve([
          {
            symbol: 'BTCUSDT' as const,
            longShortRatio: '1',
            timestamp: Date.now(),
          },
        ]),
      fetchOpenInterestHistory: () =>
        Promise.resolve([
          {
            symbol: 'BTCUSDT' as const,
            sumOpenInterest: '999',
            sumOpenInterestValue: '1',
            timestamp: Date.now() - 1,
          },
          {
            symbol: 'BTCUSDT' as const,
            sumOpenInterest: '1000',
            sumOpenInterestValue: '1',
            timestamp: Date.now(),
          },
        ]),
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    } as unknown as ConstructorParameters<typeof MarketDataService>[1];

    const service = new MarketDataService(repository, dependencies);
    await service.start();
    expect(sockets).toHaveLength(2);
    expect(fetchKlines).toHaveBeenCalledWith('BTCUSDT', '1m', 251);
    expect(fetchKlines).toHaveBeenCalledWith('BTCUSDT', '1w', 251);

    sockets[0]?.emit('open');
    sockets[0]?.emit('close');
    await vi.advanceTimersByTimeAsync(1_500);

    expect(sockets).toHaveLength(3);
    service.stop();
  });
});
