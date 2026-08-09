import { z } from 'zod';
import { WebSocket as NodeWebSocket } from 'ws';

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
import { MarketCache, type MarketStreamChannel } from './cache';
import { LocalOrderBook } from './local-order-book';
import { normalizeRestCandle } from './normalize';
import { REFERENCE_TIMEFRAMES, TIMEFRAMES } from './types';
import type { Candle, Timeframe } from './types';
import { detectCandleGaps } from './gaps';

interface CandleRepository {
  readClosedCandles(
    timeframe: Timeframe,
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
  createSocket: (url: string) => new NodeWebSocket(url) as unknown as WebSocket,
};

type MarketDataDependencies = typeof DEFAULT_DEPENDENCIES;

const STREAM_CHANNELS = ['public', 'market'] as const;
const STATISTICS_TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;
const ORDER_BOOK_RETRY_MAX_MS = 30_000;
const WS_URLS: Record<MarketStreamChannel, string> = {
  public:
    'wss://fstream.binance.com/public/stream?streams=' +
    ['btcusdt@bookTicker', 'btcusdt@depth@100ms'].join('/'),
  market:
    'wss://fstream.binance.com/market/stream?streams=' +
    [
    'btcusdt@aggTrade',
    'btcusdt@markPrice@1s',
    ...TIMEFRAMES.map((tf) => `btcusdt@kline_${tf}`),
    'btcusdt@forceOrder',
    ].join('/'),
};

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
  U: z.number(),
  u: z.number(),
  pu: z.number(),
  b: z.array(z.tuple([numericStringSchema, numericStringSchema])),
  a: z.array(z.tuple([numericStringSchema, numericStringSchema])),
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

function safeErrorDetails(error: unknown): {
  errorName: string;
  errorMessage: string;
  httpStatus?: number;
  errorCode?: string | number;
} {
  if (!(error instanceof Error))
    return { errorName: 'UnknownError', errorMessage: 'Unknown error' };
  const candidate = error as Error & { status?: unknown; code?: unknown };
  return {
    errorName: error.name,
    errorMessage: error.message.slice(0, 300),
    ...(typeof candidate.status === 'number'
      ? { httpStatus: candidate.status }
      : {}),
    ...(typeof candidate.code === 'string' || typeof candidate.code === 'number'
      ? { errorCode: candidate.code }
      : {}),
  };
}

export class MarketDataService {
  readonly cache = new MarketCache();
  private readonly sockets: Record<MarketStreamChannel, WebSocket | null> = {
    public: null,
    market: null,
  };
  private stopping = false;
  private readonly reconnectTimers: Record<
    MarketStreamChannel,
    NodeJS.Timeout | null
  > = {
    public: null,
    market: null,
  };
  private pollTimer: NodeJS.Timeout | null = null;
  private candlePollTimer: NodeJS.Timeout | null = null;
  private statisticsTimer: NodeJS.Timeout | null = null;
  private serverTimeTimer: NodeJS.Timeout | null = null;
  private exchangeInfoTimer: NodeJS.Timeout | null = null;
  private referenceCandleTimer: NodeJS.Timeout | null = null;
  private readonly plannedReconnectTimers: Record<
    MarketStreamChannel,
    NodeJS.Timeout | null
  > = {
    public: null,
    market: null,
  };
  private readonly reconnectAttempts: Record<MarketStreamChannel, number> = {
    public: 0,
    market: 0,
  };
  private serverOffsetMs = 0;
  private readonly localOrderBook = new LocalOrderBook();
  private orderBookSyncPromise: Promise<void> | null = null;
  private orderBookSyncTimer: NodeJS.Timeout | null = null;
  private orderBookSyncAttempt = 0;

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
    for (const timeframe of [...TIMEFRAMES, ...REFERENCE_TIMEFRAMES]) {
      for (const candle of this.database.readClosedCandles(timeframe))
        this.cache.upsertCandle(candle);
    }
    await this.bootstrap();
    await this.refreshReferenceCandles();
    for (const channel of STREAM_CHANNELS) this.connect(channel);
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
    this.statisticsTimer = setInterval(() => {
      void this.refreshStatistics().catch((error: unknown) => {
        logger.warn({ error }, 'Market statistics refresh failed');
      });
    }, 5 * 60_000);
    this.serverTimeTimer = setInterval(() => {
      void this.refreshServerTime().catch((error: unknown) => {
        logger.warn({ error }, 'Binance server-time refresh failed');
      });
    }, 5 * 60_000);
    this.exchangeInfoTimer = setInterval(() => {
      void this.refreshExchangeInfo().catch((error: unknown) => {
        logger.warn({ error }, 'Binance exchange-info refresh failed');
      });
    }, 5 * 60_000);
    this.referenceCandleTimer = setInterval(() => {
      void this.refreshReferenceCandles().catch((error: unknown) => {
        logger.warn({ error }, 'Reference candle refresh failed');
      });
    }, 6 * 60 * 60_000);
  }

  stop(): void {
    this.stopping = true;
    this.cancelOrderBookSyncRetry();
    for (const timer of [
      this.pollTimer,
      this.candlePollTimer,
      this.statisticsTimer,
      this.serverTimeTimer,
      this.exchangeInfoTimer,
      this.referenceCandleTimer,
    ])
      if (timer) clearTimeout(timer);
    for (const channel of STREAM_CHANNELS) {
      const reconnectTimer = this.reconnectTimers[channel];
      const plannedReconnectTimer = this.plannedReconnectTimers[channel];
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (plannedReconnectTimer) clearTimeout(plannedReconnectTimer);
      this.reconnectTimers[channel] = null;
      this.plannedReconnectTimers[channel] = null;
      this.sockets[channel]?.close();
      this.sockets[channel] = null;
      this.cache.setStreamConnected(channel, false, 'service stopped');
    }
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
    const operations: Array<{
      name: string;
      run: () => Promise<void>;
      validationError?: string;
    }> = [
      {
        name: 'Binance server time',
        run: () => this.refreshServerTime(),
      },
      {
        name: 'Binance exchange info',
        run: () => this.refreshExchangeInfo(),
        validationError: 'EXCHANGE_INFO_BOOTSTRAP_FAILED',
      },
      ...TIMEFRAMES.map((timeframe) => ({
        name: `${timeframe} candle recovery`,
        run: () => this.recoverTimeframe(timeframe),
        validationError: `CANDLE_BOOTSTRAP_FAILED_${timeframe}`,
      })),
      {
        name: 'public market state',
        run: () => this.refreshFast(),
        validationError: 'MARKET_BOOTSTRAP_FAILED',
      },
      {
        name: 'market statistics',
        run: () => this.refreshStatistics(),
      },
    ];
    await Promise.all(
      operations.map(async ({ name, run, validationError }) => {
        try {
          await run();
        } catch (error) {
          if (validationError)
            this.cache.recordValidationError(validationError);
          logger.warn({ error, operation: name }, 'Market bootstrap operation failed');
        }
      }),
    );
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
    timeframe: Timeframe,
    tuples: KlineTuple[],
  ): void {
    for (const tuple of tuples) {
      const candle = normalizeRestCandle(timeframe, tuple);
      this.cache.upsertCandle(candle);
      this.database.upsertClosedCandle(candle);
    }
  }

  private async refreshFast(): Promise<void> {
    const localBook = this.localOrderBook.view(100);
    const [markResult, tickerResult, oiResult, depthResult, tradesResult] =
      await Promise.allSettled([
      this.dependencies.fetchMarkPrice(),
      this.dependencies.fetchTicker24h(),
      this.dependencies.fetchOpenInterest(),
      localBook.synchronized
        ? Promise.resolve(null)
        : this.dependencies.fetchOrderBook(),
      this.dependencies.fetchAggregateTrades(100),
    ]);
    const receivedAt = Date.now();
    if (markResult.status === 'fulfilled') {
      const mark = markResult.value;
      this.cache.updateState(
        {
          markPrice: Number(mark.markPrice),
          indexPrice: Number(mark.indexPrice),
          fundingRate: Number(mark.lastFundingRate),
          nextFundingTime: mark.nextFundingTime,
        },
        receivedAt,
      );
    } else this.cache.recordSourceError('market', 'MARK_PRICE_REST_FAILED');
    if (tickerResult.status === 'fulfilled') {
      const ticker = tickerResult.value;
      this.cache.updateState(
        {
          lastPrice: Number(ticker.lastPrice),
          bidPrice: ticker.bidPrice === undefined ? undefined : Number(ticker.bidPrice),
          askPrice: ticker.askPrice === undefined ? undefined : Number(ticker.askPrice),
          priceChangePercent24h: Number(ticker.priceChangePercent),
          highPrice24h: Number(ticker.highPrice),
          lowPrice24h: Number(ticker.lowPrice),
          volume24h: Number(ticker.volume),
          quoteVolume24h: Number(ticker.quoteVolume),
        },
        receivedAt,
      );
    } else this.cache.recordSourceError('market', 'TICKER_REST_FAILED');
    if (
      markResult.status === 'fulfilled' &&
      tickerResult.status === 'fulfilled'
    )
      this.cache.clearSourceError('market');
    if (oiResult.status === 'fulfilled') {
      const oi = oiResult.value;
      this.cache.updateState(
        { openInterest: Number(oi.openInterest) },
        receivedAt,
        'openInterest',
        oi.time,
      );
      this.cache.clearSourceError('openInterest');
    } else this.cache.recordSourceError('openInterest', 'OPEN_INTEREST_REST_FAILED');
    const currentLocalBook = this.localOrderBook.view(100);
    if (
      !currentLocalBook.synchronized &&
      depthResult.status === 'fulfilled' &&
      depthResult.value
    ) {
      const depth = depthResult.value;
      this.cache.updateDepth(
        depth.bids.map(([price, quantity]) => [Number(price), Number(quantity)]),
        depth.asks.map(([price, quantity]) => [Number(price), Number(quantity)]),
        depth.T ?? depth.E ?? receivedAt,
        receivedAt,
        {
          synchronized: false,
          lastUpdateId: depth.lastUpdateId,
          levelCount: Math.min(depth.bids.length, depth.asks.length),
        },
      );
    } else if (
      !currentLocalBook.synchronized &&
      depthResult.status === 'rejected'
    ) {
      this.cache.recordSourceError('depth', 'FALLBACK_DEPTH_REST_FAILED');
    }
    if (tradesResult.status === 'fulfilled') {
      for (const trade of tradesResult.value)
        this.cache.addTrade({
          id: trade.a,
          eventTime: trade.T,
          receivedAt,
          price: Number(trade.p),
          quantity: Number(trade.q),
          buyerIsMaker: trade.m,
        });
      this.cache.clearSourceError('trades');
    } else
      this.cache.recordSourceError('trades', 'AGGREGATE_TRADES_REST_FAILED');
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
        ...STATISTICS_TIMEFRAMES.map((timeframe) =>
          this.dependencies.fetchOpenInterestHistory(timeframe, 2),
        ),
      ]);
    const openInterestChanges = Object.fromEntries(
      STATISTICS_TIMEFRAMES.map((timeframe, index) => {
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

  private publishOrderBook(eventTime: number, receivedAt: number): void {
    const book = this.localOrderBook.view(100);
    if (!book.synchronized) return;
    this.cache.updateDepth(book.bids, book.asks, eventTime, receivedAt, {
      synchronized: true,
      lastUpdateId: book.lastUpdateId,
      levelCount: Math.min(book.bids.length, book.asks.length),
    });
  }

  private cancelOrderBookSyncRetry(): void {
    if (this.orderBookSyncTimer) clearTimeout(this.orderBookSyncTimer);
    this.orderBookSyncTimer = null;
  }

  private markOrderBookUnsynchronized(): void {
    this.cache.markDepthUnsynchronized();
  }

  private scheduleOrderBookSync(socket: WebSocket, delayMs = 0): void {
    if (this.stopping || this.sockets.public !== socket) return;
    this.markOrderBookUnsynchronized();
    if (this.orderBookSyncPromise || this.orderBookSyncTimer) return;
    if (delayMs > 0) {
      this.orderBookSyncTimer = setTimeout(() => {
        this.orderBookSyncTimer = null;
        if (!this.stopping && this.sockets.public === socket)
          void this.synchronizeOrderBook(socket);
      }, delayMs);
      return;
    }
    void this.synchronizeOrderBook(socket);
  }

  private synchronizeOrderBook(socket: WebSocket): Promise<void> {
    if (this.orderBookSyncPromise) return this.orderBookSyncPromise;
    let pendingRetryMs: number | null = null;
    this.orderBookSyncPromise = (async () => {
      const snapshot = await this.dependencies.fetchOrderBook(1000);
      if (this.stopping || this.sockets.public !== socket) return;
      const synchronized = this.localOrderBook.initialize({
        lastUpdateId: snapshot.lastUpdateId,
        bids: snapshot.bids.map(([price, quantity]) => [
          Number(price),
          Number(quantity),
        ]),
        asks: snapshot.asks.map(([price, quantity]) => [
          Number(price),
          Number(quantity),
        ]),
      });
      if (!synchronized)
        throw new Error('Binance depth snapshot did not overlap buffered events');
      if (this.stopping || this.sockets.public !== socket) return;
      this.publishOrderBook(snapshot.T ?? snapshot.E ?? Date.now(), Date.now());
      this.orderBookSyncAttempt = 0;
      this.cancelOrderBookSyncRetry();
      this.cache.clearSourceError('depth');
    })()
      .catch((error: unknown) => {
        if (this.stopping || this.sockets.public !== socket) return;
        this.markOrderBookUnsynchronized();
        this.cache.recordSourceError('depth', 'ORDER_BOOK_RESYNC_FAILED');
        const attempt = this.orderBookSyncAttempt + 1;
        const base = Math.min(
          ORDER_BOOK_RETRY_MAX_MS,
          1_000 * 2 ** this.orderBookSyncAttempt,
        );
        const nextRetryMs = Math.min(
          ORDER_BOOK_RETRY_MAX_MS,
          Math.round(base * (0.8 + Math.random() * 0.4)),
        );
        this.orderBookSyncAttempt = attempt;
        const details = safeErrorDetails(error);
        logger.warn(
          { ...details, attempt, nextRetryMs },
          'Binance local order book resync failed',
        );
        pendingRetryMs = nextRetryMs;
      })
      .finally(() => {
        this.orderBookSyncPromise = null;
        if (pendingRetryMs !== null)
          this.scheduleOrderBookSync(socket, pendingRetryMs);
      });
    return this.orderBookSyncPromise;
  }

  private connect(channel: MarketStreamChannel): void {
    if (this.stopping) return;
    const socket = this.dependencies.createSocket(WS_URLS[channel]);
    this.sockets[channel] = socket;
    socket.addEventListener('open', () => {
      if (this.sockets[channel] !== socket) return;
      this.reconnectAttempts[channel] = 0;
      this.cache.setStreamConnected(channel, true);
      if (channel === 'public') {
        this.localOrderBook.reset();
        this.orderBookSyncAttempt = 0;
        this.cancelOrderBookSyncRetry();
        this.scheduleOrderBookSync(socket);
      }
      this.plannedReconnectTimers[channel] = setTimeout(
        () => socket.close(1000, 'planned reconnect'),
        23 * 60 * 60_000,
      );
      logger.info({ channel }, 'Binance WebSocket connected');
    });
    socket.addEventListener('message', (event) => {
      try {
        this.ingestRecordedMessage(String(event.data), Date.now());
      } catch (error) {
        logger.warn(
          { channel, error },
          'Binance WebSocket schema validation failed',
        );
      }
    });
    socket.addEventListener('error', () => {
      logger.warn({ channel }, 'Binance WebSocket error');
    });
    socket.addEventListener('close', () => {
      if (this.sockets[channel] !== socket) return;
      const plannedReconnectTimer = this.plannedReconnectTimers[channel];
      if (plannedReconnectTimer) clearTimeout(plannedReconnectTimer);
      this.plannedReconnectTimers[channel] = null;
      this.sockets[channel] = null;
      if (channel === 'public') {
        this.cancelOrderBookSyncRetry();
        this.orderBookSyncAttempt = 0;
        this.cache.markDepthUnsynchronized();
      }
      this.cache.setStreamConnected(
        channel,
        false,
        `${channel} WebSocket disconnected`,
      );
      this.scheduleReconnect(channel);
    });
  }

  private async refreshReferenceCandles(): Promise<void> {
    await Promise.all(
      REFERENCE_TIMEFRAMES.map(async (timeframe) => {
        const tuples = await this.dependencies.fetchKlines(
          'BTCUSDT',
          timeframe,
          251,
        );
        this.applyRestCandles(timeframe, tuples);
      }),
    );
  }

  private scheduleReconnect(channel: MarketStreamChannel): void {
    if (this.stopping || this.reconnectTimers[channel]) return;
    const base = Math.min(
      30_000,
      1_000 * 2 ** this.reconnectAttempts[channel],
    );
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts[channel] += 1;
    this.reconnectTimers[channel] = setTimeout(() => {
      this.reconnectTimers[channel] = null;
      if (channel === 'public') {
        this.connect(channel);
        return;
      }
      void Promise.all(TIMEFRAMES.map((tf) => this.recoverTimeframe(tf)))
        .catch((error: unknown) => {
          logger.warn({ channel, error }, 'REST gap recovery failed');
        })
        .finally(() => this.connect(channel));
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
    if (envelope.stream.includes('@depth')) {
      const event = depthSchema.parse(envelope.data);
      const result = this.localOrderBook.ingest({
        eventTime: event.E,
        firstUpdateId: event.U,
        finalUpdateId: event.u,
        previousFinalUpdateId: event.pu,
        bids: event.b.map(([price, quantity]) => [
          Number(price),
          Number(quantity),
        ]),
        asks: event.a.map(([price, quantity]) => [
          Number(price),
          Number(quantity),
        ]),
      });
      if (result === 'APPLIED') this.publishOrderBook(event.E, receivedAt);
      else if (result === 'GAP' || result === 'BUFFERED') {
        const socket = this.sockets.public;
        if (socket) this.scheduleOrderBookSync(socket);
      }
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
