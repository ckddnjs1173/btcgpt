import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KlineTuple } from '../../src/main/binance/schemas';
import { MarketDataService } from '../../src/main/market/service';
import type { Candle } from '../../src/main/market/types';

const repository = {
  readClosedCandles: () => [] as Candle[],
  upsertClosedCandle: () => undefined,
};

class FakeSocket {
  readonly listeners = new Map<string, Array<() => void>>();
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
    this.emit('close');
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

function dependencies(sockets: FakeSocket[]) {
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
  const fetchKlines = (_symbol: 'BTCUSDT', timeframe: string) => {
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
  };

  return {
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
}

function disablePeriodicWork(service: MarketDataService) {
  const internal = service as unknown as Record<string, NodeJS.Timeout | null>;
  for (const key of [
    'pollTimer',
    'candlePollTimer',
    'statisticsTimer',
    'serverTimeTimer',
    'exchangeInfoTimer',
    'referenceCandleTimer',
    'telemetryTimer',
  ]) {
    const timer = internal[key];
    if (timer) clearInterval(timer);
    internal[key] = null;
  }
}

describe('BTC WebSocket lifecycle hardening', () => {
  afterEach(() => vi.useRealTimers());

  it('forces both Binance stream connections through a planned reconnect before the 24h server lifetime', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const service = new MarketDataService(repository, dependencies(sockets));
    await service.start();
    disablePeriodicWork(service);

    expect(sockets).toHaveLength(2);
    sockets[0]?.emit('open');
    sockets[1]?.emit('open');

    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    expect(sockets[0]?.closes.at(-1)?.reason).toBe('planned reconnect');
    expect(sockets[1]?.closes.at(-1)?.reason).toBe('planned reconnect');

    await vi.advanceTimersByTimeAsync(1_500);
    expect(sockets.length).toBeGreaterThanOrEqual(4);
    service.stop();
  });

  it('does not allow a queued reconnect from an old run generation after stop', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const service = new MarketDataService(repository, dependencies(sockets));
    await service.start();
    disablePeriodicWork(service);

    expect(sockets).toHaveLength(2);
    sockets[0]?.emit('open');
    sockets[0]?.emit('close');
    service.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
  });
});
