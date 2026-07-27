import { z } from 'zod';

import { numericStringSchema, type KlineTuple } from '../binance/schemas';
import {
  fetchAggregateTrades,
  fetchExchangeInfo,
  fetchKlines,
  fetchMarkPrice,
  fetchOpenInterest,
  fetchOpenInterestHistory,
  fetchOrderBook,
  fetchRatioHistory,
  fetchServerTime,
  fetchTicker24h,
} from '../binance/public/rest';
import { logger } from '../logging/logger';
import { percentageChange } from '../../shared/calculations/market';
import { MarketCache } from './cache';
import { normalizeRestCandle } from './normalize';
import { TIMEFRAMES } from './types';
import type { Candle } from './types';
import { detectCandleGaps } from './gaps';

interface CandleRepository {
  readClosedCandles(
    timeframe: (typeof TIMEFRAMES)[number],
    limit?: number,
  ): Candle[];
  upsertClosedCandle(candle: Candle): void;
}

const DEFAULT_DEPENDENCIES = {
  fetchAggregateTrades,
  fetchServerTime,
  fetchExchangeInfo,
  fetchKlines,
  fetchMarkPrice,
  fetchOpenInterest,
  fetchOpenInterestHistory,
  fetchOrderBook,
  fetchRatioHistory,
  fetchTicker24h,
  createSocket: (url: string) => new WebSocket(url),
};

type MarketDataDependencies = typeof DEFAULT_DEPENDENCIES;

const WS_URL =
  'wss://fstream.binance.com/stream?streams=' +
  [
    'btcusdt@aggTrade',
    'btcusdt@markPrice@1s',
    ...TIMEFRAMES.map((tf) => `btcusdt@kline_${tf}`),
    'btcusdt@bookTicker',
    'btcusdt@depth20@100ms',
    'btcusdt@forceOrder',
  ].join('/');

const streamEnvelopeSchema = z.object({
  stream: z.string(),
  data: z.record(z.string(), z.unknown()),
});
const klineEventSchema = z.object({
  E: z.number(),
  s: z.literal('BTCUSDT'),
  k: z.object({
    t: z.number(),
    T: z.number(),
    s: z.literal('BTCUSDT'),
    i: z.enum(TIMEFRAMES),
    o: numericStringSchema,
    c: numericStringSchema,
    h: numericStringSchema,
    l: numericStringSchema,
    v: numericStringSchema,
    q: numericStringSchema,
    n: z.number(),
    V: numericStringSchema,
    Q: numericStringSchema,
    x: z.boolean(),
  }),
});
const markEventSchema = z.object({
  E: z.number(),
  s: z.literal('BTCUSDT'),
  p: numericStringSchema,
  i: numericStringSchema,
  r: numericStringSchema,
  T: z.number(),
});
const bookTickerSchema = z.object({
  E: z.number(),
  s: z.literal('BTCUSDT'),
  b: numericStringSchema,
  a: numericStringSchema,
});
const aggTradeSchema = z.object({
  a: z.number(),
  E: z.number(),
  s: z.literal('BTCUSDT'),
  p: numericStringSchema,
  q: numericStringSchema,
  T: z.number(),
  m: z.boolean(),
});
const depthSchema = z.object({
  E: z.number(),
  s: z.literal('BTCUSDT').optional(),
  b: z.array(z.tuple([numericStringSchema, numericStringSchema])).min(1),
  a: z.array(z.tuple([numericStringSchema, numericStringSchema])).min(1),
});
const forceOrderSchema = z.object({
  E: z.number(),
  o: z.object({
    s: z.literal('BTCUSDT'),
    S: z.enum(['BUY', 'SELL']),
    q: numericStringSchema,
    ap: numericStringSchema,
    p: numericStringSchema,
    T: z.number(),
  }),
});

export class MarketDataService {
  readonly cache = new MarketCache();
  private socket: WebSocket | null = null;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private candlePollTimer: NodeJS.Timeout | null = null;
  private statisticsTimer: NodeJS.Timeout | null = null;
  private serverTimeTimer: NodeJS.Timeout | null = null;
  private exchangeInfoTimer: NodeJS.Timeout | null = null;
  private plannedReconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private serverOffsetMs = 0;

  private readonly dependencies: MarketDataDependencies;

  constructor(
    private readonly database: CandleRepository,
    dependencies: Partial<MarketDataDependencies> = {},
  ) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  getServerOffsetMs(): number {
    return this.serverOffsetMs;
  }

  async start(): Promise<void> {
    this.stopping = false;
    for (const timeframe of TIMEFRAMES) {
      for (const candle of this.database.readClosedCandles(timeframe))
        this.cache.upsertCandle(candle);
    }
    await this.bootstrap();
    this.connect();
    this.pollTimer = setInterval(() => {
      void this.refreshFast().catch((error: unknown) => {
        this.cache.recordValidationError('REST_REFRESH_FAILED');
        logger.warn({ error }, 'Public REST refresh failed');
      });
    }, 5_000);
    this.candlePollTimer = setInterval(() => {
      void this.refreshCandles().catch((error: unknown) => {
        this.cache.recordValidationError('CANDLE_REST_REFRESH_FAILED');
        logger.warn({ error }, 'Candle REST refresh failed');
      });
    }, 15_000);
    this.statisticsTimer = setInterval(
      () => void this.refreshStatistics(),
      5 * 60_000,
    );
    this.serverTimeTimer = setInterval(
      () => void this.refreshServerTime(),
      30 * 60_000,
    );
    this.exchangeInfoTimer = setInterval(
      () => void this.refreshExchangeInfo(),
      24 * 60 * 60_000,
    );
  }

  stop(): void {
    this.stopping = true;
    for (const timer of [
      this.reconnectTimer,
      this.pollTimer,
      this.candlePollTimer,
      this.statisticsTimer,
      this.serverTimeTimer,
      this.exchangeInfoTimer,
      this.plannedReconnectTimer,
    ])
      if (timer) clearTimeout(timer);
    this.socket?.close();
    this.socket = null;
    this.cache.setConnected(false, 'service stopped');
  }

  ingestRecordedMessage(raw: string, receivedAt = Date.now()): void {
    try {
      this.handleMessage(raw, receivedAt);
    } catch (error) {
      this.cache.recordValidationError(
        error instanceof Error ? error.message : 'SCHEMA_VALIDATION_FAILED',
      );
      throw error;
    }
  }

  private async bootstrap(): Promise<void> {
    await Promise.all([this.refreshServerTime(), this.refreshExchangeInfo()]);
    await Promise.all([
      ...TIMEFRAMES.map((timeframe) => this.recoverTimeframe(timeframe)),
      this.refreshFast(),
      this.refreshStatistics(),
    ]);
  }

  private async refreshServerTime(): Promise<void> {
    const localStart = Date.now();
    const time = await this.dependencies.fetchServerTime();
    const localEnd = Date.now();
    this.serverOffsetMs =
      time.serverTime - Math.round((localStart + localEnd) / 2);
  }

  private async refreshExchangeInfo(): Promise<void> {
    const exchange = await this.dependencies.fetchExchangeInfo();
    const localEnd = Date.now();
    const product = exchange.symbols.find(
      (item) =>
        item.symbol === 'BTCUSDT' &&
        item.contractType === 'PERPETUAL' &&
        item.status === 'TRADING',
    );
    if (!product) throw new Error('BTCUSDT perpetual product is unavailable');
    const price = product.filters.find(
      (filter) => filter.filterType === 'PRICE_FILTER',
    );
    const lot = product.filters.find(
      (filter) => filter.filterType === 'LOT_SIZE',
    );
    const notional = product.filters.find(
      (filter) => filter.filterType === 'MIN_NOTIONAL',
    );
    if (
      !price ||
      !('tickSize' in price) ||
      !lot ||
      !('stepSize' in lot) ||
      !('minQty' in lot) ||
      !notional ||
      !('notional' in notional)
    )
      throw new Error('Required BTCUSDT exchange filters are missing');
    this.cache.setProductFilters({
      tickSize: Number(price.tickSize),
      stepSize: Number(lot.stepSize),
      minQuantity: Number(lot.minQty),
      minNotional: Number(notional.notional),
      updatedAt: localEnd,
    });
  }

  private async recoverTimeframe(
    timeframe: (typeof TIMEFRAMES)[number],
  ): Promise<void> {
    const tuples = await this.dependencies.fetchKlines(
      'BTCUSDT',
      timeframe,
      251,
    );
    this.applyRestCandles(timeframe, tuples);
    const recovered = tuples
      .map((tuple) => normalizeRestCandle(timeframe, tuple))
      .filter((candle) => candle.isClosed);
    const gaps = detectCandleGaps(recovered, timeframe);
    if (gaps.length > 0) {
      this.cache.recordValidationError(`CANDLE_GAP_${timeframe}`);
      throw new Error(
        `REST recovery left ${gaps.length} ${timeframe} candle gaps`,
      );
    }
  }

  private applyRestCandles(
    timeframe: (typeof TIMEFRAMES)[number],
    tuples: KlineTuple[],
  ): void {
    for (const tuple of tuples) {
      const candle = normalizeRestCandle(timeframe, tuple);
      this.cache.upsertCandle(candle);
      this.database.upsertClosedCandle(candle);
    }
  }

  private async refreshFast(): Promise<void> {
    const [mark, ticker, oi, depth, trades] = await Promise.all([
      this.dependencies.fetchMarkPrice(),
      this.dependencies.fetchTicker24h(),
      this.dependencies.fetchOpenInterest(),
      this.dependencies.fetchOrderBook(),
      this.dependencies.fetchAggregateTrades(100),
    ]);
    const receivedAt = Date.now();
    this.cache.updateState(
      {
        lastPrice: Number(ticker.lastPrice),
        markPrice: Number(mark.markPrice),
        indexPrice: Number(mark.indexPrice),
        fundingRate: Number(mark.lastFundingRate),
        nextFundingTime: mark.nextFundingTime,
        bidPrice:
          ticker.bidPrice !== undefined
            ? Number(ticker.bidPrice)
            : Number(depth.bids[0]?.[0]),
        askPrice:
          ticker.askPrice !== undefined
            ? Number(ticker.askPrice)
            : Number(depth.asks[0]?.[0]),
        priceChangePercent24h: Number(ticker.priceChangePercent),
        highPrice24h: Number(ticker.highPrice),
        lowPrice24h: Number(ticker.lowPrice),
        volume24h: Number(ticker.volume),
        quoteVolume24h: Number(ticker.quoteVolume),
      },
      receivedAt,
    );
    this.cache.updateState(
      { openInterest: Number(oi.openInterest) },
      receivedAt,
      'openInterest',
      oi.time,
    );
    this.cache.updateDepth(
      depth.bids.map(([price, quantity]) => [Number(price), Number(quantity)]),
      depth.asks.map(([price, quantity]) => [Number(price), Number(quantity)]),
      depth.T ?? depth.E ?? receivedAt,
      receivedAt,
    );
    for (const trade of trades)
      this.cache.addTrade({
        id: trade.a,
        eventTime: trade.T,
        receivedAt,
        price: Number(trade.p),
        quantity: Number(trade.q),
        buyerIsMaker: trade.m,
      });
  }

  private async refreshCandles(): Promise<void> {
    await Promise.all(
      TIMEFRAMES.map(async (timeframe) => {
        const tuples = await this.dependencies.fetchKlines(
          'BTCUSDT',
          timeframe,
          3,
        );
        this.applyRestCandles(timeframe, tuples);
        const gaps = detectCandleGaps(
          this.cache.getClosed(timeframe).slice(-251),
          timeframe,
        );
        if (gaps.length > 0) await this.recoverTimeframe(timeframe);
      }),
    );
  }

  private async refreshStatistics(): Promise<void> {
    const [global, topAccount, topPosition, taker, ...oiHistories] =
      await Promise.all([
        this.dependencies.fetchRatioHistory(
          '/futures/data/globalLongShortAccountRatio',
        ),
        this.dependencies.fetchRatioHistory(
          '/futures/data/topLongShortAccountRatio',
        ),
        this.dependencies.fetchRatioHistory(
          '/futures/data/topLongShortPositionRatio',
        ),
        this.dependencies.fetchRatioHistory(
          '/futures/data/takerlongshortRatio',
        ),
        ...TIMEFRAMES.map((timeframe) =>
          this.dependencies.fetchOpenInterestHistory(timeframe, 2),
        ),
      ]);
    const openInterestChanges = Object.fromEntries(
      TIMEFRAMES.map((timeframe, index) => {
        const history = oiHistories[index] ?? [];
        return [
          timeframe,
          history.length >= 2
            ? percentageChange(
                Number(history.at(-1)?.sumOpenInterest),
                Number(history.at(-2)?.sumOpenInterest),
              )
            : null,
        ];
      }),
    );
    const optionalNumber = (value: string | undefined): number | null => {
      if (value === undefined) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    this.cache.updateSentiment({
      globalLongShortAccountRatio: optionalNumber(
        global.at(-1)?.longShortRatio,
      ),
      topLongShortAccountRatio: optionalNumber(
        topAccount.at(-1)?.longShortRatio,
      ),
      topLongShortPositionRatio: optionalNumber(
        topPosition.at(-1)?.longShortRatio,
      ),
      takerBuySellRatio: optionalNumber(
        taker.at(-1)?.buySellRatio ?? taker.at(-1)?.longShortRatio,
      ),
      openInterestChanges,
    });
  }

  private connect(): void {
    if (this.stopping) return;
    const socket = this.dependencies.createSocket(WS_URL);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.cache.setConnected(true);
      this.plannedReconnectTimer = setTimeout(
        () => socket.close(1000, 'planned reconnect'),
        23 * 60 * 60_000,
      );
      logger.info('Binance public WebSocket connected');
    });
    socket.addEventListener('message', (event) => {
      try {
        this.ingestRecordedMessage(String(event.data), Date.now());
      } catch (error) {
        logger.warn({ error }, 'Binance WebSocket schema validation failed');
      }
    });
    socket.addEventListener('error', () => {
      logger.warn('Binance public WebSocket error');
    });
    socket.addEventListener('close', () => {
      if (this.plannedReconnectTimer) clearTimeout(this.plannedReconnectTimer);
      this.plannedReconnectTimer = null;
      this.cache.setConnected(false, 'WebSocket disconnected');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const base = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void Promise.all(TIMEFRAMES.map((tf) => this.recoverTimeframe(tf)))
        .catch((error: unknown) =>
          logger.warn({ error }, 'REST gap recovery failed'),
        )
        .finally(() => this.connect());
    }, delay);
  }

  private handleMessage(raw: string, receivedAt: number): void {
    const envelope = streamEnvelopeSchema.parse(JSON.parse(raw) as unknown);
    if (envelope.stream.includes('@kline_')) {
      const event = klineEventSchema.parse(envelope.data);
      const k = event.k;
      const candle = {
        symbol: 'BTCUSDT' as const,
        timeframe: k.i,
        openTime: k.t,
        closeTime: k.T,
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
        quoteVolume: Number(k.q),
        tradeCount: k.n,
        takerBuyBaseVolume: Number(k.V),
        takerBuyQuoteVolume: Number(k.Q),
        isClosed: k.x,
        eventTime: event.E,
        receivedAt,
      };
      this.cache.upsertCandle(candle);
      this.database.upsertClosedCandle(candle);
      return;
    }
    if (envelope.stream.includes('@markPrice')) {
      const event = markEventSchema.parse(envelope.data);
      this.cache.updateState(
        {
          markPrice: Number(event.p),
          indexPrice: Number(event.i),
          fundingRate: Number(event.r),
          nextFundingTime: event.T,
        },
        receivedAt,
        'market',
        event.E,
      );
      return;
    }
    if (envelope.stream.includes('@bookTicker')) {
      const event = bookTickerSchema.parse(envelope.data);
      this.cache.updateState(
        { bidPrice: Number(event.b), askPrice: Number(event.a) },
        receivedAt,
        'bookTicker',
        event.E,
      );
      return;
    }
    if (envelope.stream.includes('@aggTrade')) {
      const event = aggTradeSchema.parse(envelope.data);
      this.cache.addTrade({
        id: event.a,
        eventTime: event.T,
        receivedAt,
        price: Number(event.p),
        quantity: Number(event.q),
        buyerIsMaker: event.m,
      });
      this.cache.updateState(
        { lastPrice: Number(event.p) },
        receivedAt,
        'trades',
        event.E,
      );
      return;
    }
    if (envelope.stream.includes('@depth20')) {
      const event = depthSchema.parse(envelope.data);
      this.cache.updateDepth(
        event.b.map(([price, quantity]) => [Number(price), Number(quantity)]),
        event.a.map(([price, quantity]) => [Number(price), Number(quantity)]),
        event.E,
        receivedAt,
      );
      return;
    }
    if (envelope.stream.includes('@forceOrder')) {
      const event = forceOrderSchema.parse(envelope.data);
      const price = Number(event.o.ap) || Number(event.o.p);
      const quantity = Number(event.o.q);
      this.cache.addLiquidation({
        eventTime: event.o.T,
        receivedAt,
        side: event.o.S,
        price,
        quantity,
        notional: price * quantity,
      });
    }
  }
}
