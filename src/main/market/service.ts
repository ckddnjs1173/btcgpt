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
  private started = false;
  private runGeneration = 0;
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

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    this.stopping = false;
    const runId = ++this.runGeneration;
    for (const timeframe of [...TIMEFRAMES, ...REFERENCE_TIMEFRAMES]) {
      for (const candle of this.database.readClosedCandles(timeframe))
        this.cache.upsertCandle(candle);
    }
    for (const channel of STREAM_CHANNELS) this.connect(channel, runId);
    this.pollTimer = setInterval(() => {
      void this.refreshFast(runId);
    }, 5_000);
    this.candlePollTimer = setInterval(() => {
      void this.refreshCandles(runId);
    }, 15_000);
    this.statisticsTimer = setInterval(() => {
      void this.refreshStatistics(runId);
    }, 5 * 60_000);
    this.serverTimeTimer = setInterval(() => {
      void this.runOptionalTask(runId, 'serverTime', () => this.refreshServerTime(runId));
    }, 5 * 60_000);
    this.exchangeInfoTimer = setInterval(() => {
      void this.runOptionalTask(runId, 'exchangeInfo', () => this.refreshExchangeInfo(runId));
    }, 5 * 60_000);
    this.referenceCandleTimer = setInterval(() => {
      void this.refreshReferenceCandles(runId);
    }, 6 * 60 * 60_000);
    this.bootstrap(runId);
    return Promise.resolve();
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    this.runGeneration += 1;
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
      this.cache.setStreamConnected(channel, false, 'SERVICE_STOPPED');
    }
  }

  private isRunActive(runId: number): boolean {
    return !this.stopping && this.started && this.runGeneration === runId;
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

  private bootstrap(runId: number): void {
    const operations: Array<{
      name: string;
      source: string;
      run: () => Promise<void>;
      validationError?: string;
    }> = [
      {
        name: 'Binance server time',
        source: 'serverTime',
        run: () => this.refreshServerTime(runId),
        validationError: 'SERVER_TIME_BOOTSTRAP_FAILED',
      },
      {
        name: 'Binance exchange info',
        source: 'exchangeInfo',
        run: () => this.refreshExchangeInfo(runId),
        validationError: 'EXCHANGE_INFO_BOOTSTRAP_FAILED',
      },
      ...TIMEFRAMES.map((timeframe) => ({
        name: `${timeframe} candle recovery`,
        source: `candle:${timeframe}`,
        run: () => this.recoverTimeframe(timeframe, runId),
        validationError: `CANDLE_BOOTSTRAP_FAILED_${timeframe}`,
      })),
      {
        name: 'public market state',
        source: 'market',
        run: () => this.refreshFast(runId),
        validationError: 'MARKET_BOOTSTRAP_FAILED',
      },
      {
        name: 'market statistics',
        source: 'statistics',
        run: () => this.refreshStatistics(runId),
      },
      ...REFERENCE_TIMEFRAMES.map((timeframe) => ({
        name: `${timeframe} reference candle recovery`,
        source: `candle:${timeframe}`,
        run: () => this.refreshReferenceTimeframe(timeframe, runId),
        validationError: `CANDLE_BOOTSTRAP_FAILED_${timeframe}`,
      })),
    ];
    for (const { name, source, run, validationError } of operations)
      void run().catch((error: unknown) => {
        if (!this.isRunActive(runId)) return;
        if (validationError)
          this.cache.recordSourceError(source, validationError);
        logger.warn(
          { operation: name, ...safeErrorDetails(error) },
          'Market bootstrap operation failed',
        );
      });
  }

  private async runOptionalTask(
    runId: number,
    source: string,
    task: () => Promise<void>,
  ): Promise<void> {
    try {
      await task();
      if (!this.isRunActive(runId)) return;
      this.cache.clearSourceError(source);
    } catch (error) {
      if (!this.isRunActive(runId)) return;
      this.cache.recordSourceError(source, `${source.toUpperCase()}_REST_FAILED`);
      logger.warn(
        { source, ...safeErrorDetails(error) },
        'Optional market REST source failed',
      );
    }
  }

  private async refreshServerTime(runId: number): Promise<void> {
    const localStart = Date.now();
    const time = await this.dependencies.fetchServerTime();
    if (!this.isRunActive(runId)) return;
    const localEnd = Date.now();
    this.serverOffsetMs =
      time.serverTime - Math.round((localStart + localEnd) / 2);
    this.cache.clearSourceError('serverTime');
  }

  private async refreshExchangeInfo(runId: number): Promise<void> {
    const exchange = await this.dependencies.fetchExchangeInfo();
    if (!this.isRunActive(runId)) return;
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
    this.cache.clearSourceError('exchangeInfo');
  }

  private async recoverTimeframe(
    timeframe: (typeof TIMEFRAMES)[number],
    runId: number,
  ): Promise<void> {
    const tuples = await this.dependencies.fetchKlines(
      'BTCUSDT',
      timeframe,
      251,
    );
    if (!this.isRunActive(runId)) return;
    this.applyRestCandles(timeframe, tuples);
    const recovered = tuples
      .map((tuple) => normalizeRestCandle(timeframe, tuple))
      .filter((candle) => candle.isClosed);
    const gaps = detectCandleGaps(recovered, timeframe);
    if (gaps.length > 0) {
      this.cache.recordSourceError(
        `candle:${timeframe}`,
        `CANDLE_GAP_${timeframe}`,
      );
      throw new Error(
        `REST recovery left ${gaps.length} ${timeframe} candle gaps`,
      );
    }
    this.cache.clearSourceError(`candle:${timeframe}`);
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

  private async refreshFast(runId: number): Promise<void> {
    const localBook = this.localOrderBook.view(100);
    const markTask = this.dependencies.fetchMarkPrice().then(
      (mark) => {
        if (!this.isRunActive(runId)) return;
        const receivedAt = Date.now();
        this.cache.updateState(
          {
            markPrice: Number(mark.markPrice),
            indexPrice: Number(mark.indexPrice),
            fundingRate: Number(mark.lastFundingRate),
            nextFundingTime: mark.nextFundingTime,
          },
          receivedAt,
          'market',
          receivedAt,
        );
        this.cache.clearSourceError('market:markRest');
      },
      () => {
        if (this.isRunActive(runId))
          this.cache.recordSourceError('market:markRest', 'MARK_PRICE_REST_FAILED');
      },
    );
    const tickerTask = this.dependencies.fetchTicker24h().then(
      (ticker) => {
        if (!this.isRunActive(runId)) return;
        const receivedAt = Date.now();
        this.cache.updateState(
          {
            lastPrice: Number(ticker.lastPrice),
            priceChangePercent24h: Number(ticker.priceChangePercent),
            highPrice24h: Number(ticker.highPrice),
            lowPrice24h: Number(ticker.lowPrice),
            volume24h: Number(ticker.volume),
            quoteVolume24h: Number(ticker.quoteVolume),
          },
          receivedAt,
          'market',
          receivedAt,
        );
        if (ticker.bidPrice !== undefined && ticker.askPrice !== undefined)
          this.cache.updateState(
            {
              bidPrice: Number(ticker.bidPrice),
              askPrice: Number(ticker.askPrice),
            },
            receivedAt,
            'bookTicker',
            receivedAt,
          );
        this.cache.clearSourceError('market:tickerRest');
      },
      () => {
        if (this.isRunActive(runId))
          this.cache.recordSourceError('market:tickerRest', 'TICKER_REST_FAILED');
      },
    );
    const oiTask = this.dependencies.fetchOpenInterest().then(
      (oi) => {
        if (!this.isRunActive(runId)) return;
        this.cache.updateState(
          { openInterest: Number(oi.openInterest) },
          Date.now(),
          'openInterest',
          oi.time,
        );
        this.cache.clearSourceError('openInterest');
      },
      () => {
        if (this.isRunActive(runId))
          this.cache.recordSourceError(
            'openInterest',
            'OPEN_INTEREST_REST_FAILED',
          );
      },
    );
    const depthTask = localBook.synchronized
      ? Promise.resolve()
      : this.dependencies.fetchOrderBook().then(
          (depth) => {
            if (
              !this.isRunActive(runId) ||
              this.localOrderBook.view(1).synchronized
            )
              return;
            const receivedAt = Date.now();
            this.cache.updateDepth(
              depth.bids.map(([price, quantity]) => [
                Number(price),
                Number(quantity),
              ]),
              depth.asks.map(([price, quantity]) => [
                Number(price),
                Number(quantity),
              ]),
              depth.T ?? depth.E ?? receivedAt,
              receivedAt,
              {
                synchronized: false,
                lastUpdateId: depth.lastUpdateId,
                levelCount: Math.min(depth.bids.length, depth.asks.length),
              },
            );
          },
          () => {
            if (this.isRunActive(runId))
              this.cache.recordSourceError('depth', 'FALLBACK_DEPTH_REST_FAILED');
          },
        );
    const tradesTask = this.dependencies.fetchAggregateTrades(100).then(
      (trades) => {
        if (!this.isRunActive(runId)) return;
        const receivedAt = Date.now();
        for (const trade of trades)
          this.cache.addTrade({
            id: trade.a,
            eventTime: trade.T,
            receivedAt,
            price: Number(trade.p),
            quantity: Number(trade.q),
            buyerIsMaker: trade.m,
          });
        this.cache.clearSourceError('trades');
      },
      () => {
        if (this.isRunActive(runId))
          this.cache.recordSourceError('trades', 'AGGREGATE_TRADES_REST_FAILED');
      },
    );
    await Promise.allSettled([
      markTask,
      tickerTask,
      oiTask,
      depthTask,
      tradesTask,
    ]);
  }

  private async refreshCandles(runId: number): Promise<void> {
    await Promise.allSettled(
      TIMEFRAMES.map(async (timeframe) => {
        try {
        const tuples = await this.dependencies.fetchKlines(
          'BTCUSDT',
          timeframe,
          3,
        );
        if (!this.isRunActive(runId)) return;
        this.applyRestCandles(timeframe, tuples);
        const gaps = detectCandleGaps(
          this.cache.getClosed(timeframe).slice(-251),
          timeframe,
        );
        if (gaps.length > 0) await this.recoverTimeframe(timeframe, runId);
        this.cache.clearSourceError(`candle:${timeframe}`);
        } catch (error) {
          if (!this.isRunActive(runId)) return;
          this.cache.recordSourceError(
            `candle:${timeframe}`,
            `CANDLE_REST_REFRESH_FAILED_${timeframe}`,
          );
          logger.warn(
            { timeframe, ...safeErrorDetails(error) },
            'Candle REST refresh failed',
          );
        }
      }),
    );
  }

  private async refreshStatistics(runId: number): Promise<void> {
    const [global, topAccount, topPosition, taker, ...oiHistories] =
      await Promise.allSettled([
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
    if (!this.isRunActive(runId)) return;
    const optionalNumber = (value: string | undefined): number | null => {
      if (value === undefined) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const sentiment: Parameters<MarketCache['updateSentiment']>[0] = {};
    const applyRatio = (
      result: typeof global,
      field:
        | 'globalLongShortAccountRatio'
        | 'topLongShortAccountRatio'
        | 'topLongShortPositionRatio'
        | 'takerBuySellRatio',
      source: string,
    ): void => {
      if (result.status === 'fulfilled') {
        const latest = result.value.at(-1);
        sentiment[field] = optionalNumber(
          field === 'takerBuySellRatio'
            ? latest?.buySellRatio ?? latest?.longShortRatio
            : latest?.longShortRatio,
        );
        this.cache.clearSourceError(source);
      } else this.cache.recordSourceError(source, `${source.toUpperCase()}_FAILED`);
    };
    applyRatio(global, 'globalLongShortAccountRatio', 'statistics:globalRatio');
    applyRatio(topAccount, 'topLongShortAccountRatio', 'statistics:topAccount');
    applyRatio(topPosition, 'topLongShortPositionRatio', 'statistics:topPosition');
    applyRatio(taker, 'takerBuySellRatio', 'statistics:takerRatio');
    const openInterestChanges: NonNullable<
      Parameters<MarketCache['updateSentiment']>[0]['openInterestChanges']
    > = {};
    STATISTICS_TIMEFRAMES.forEach((timeframe, index) => {
        const result = oiHistories[index];
        const history = result?.status === 'fulfilled' ? result.value : [];
        const source = `statistics:oi:${timeframe}`;
        if (result?.status === 'fulfilled') {
          this.cache.clearSourceError(source);
          openInterestChanges[timeframe] = history.length >= 2
            ? percentageChange(
                Number(history.at(-1)?.sumOpenInterest),
                Number(history.at(-2)?.sumOpenInterest),
              )
            : null;
        } else
          this.cache.recordSourceError(source, `OI_HISTORY_FAILED_${timeframe}`);
      });
    if (Object.keys(openInterestChanges).length > 0)
      sentiment.openInterestChanges = openInterestChanges;
    if (Object.keys(sentiment).length > 0) this.cache.updateSentiment(sentiment);
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

  private completeOrderBookSynchronization(
    eventTime: number,
    receivedAt: number,
  ): void {
    this.publishOrderBook(eventTime, receivedAt);
    this.orderBookSyncAttempt = 0;
    this.cancelOrderBookSyncRetry();
    this.cache.clearSourceError('depth');
    logger.info(
      {
        ...this.localOrderBook.diagnostics(),
        attempt: 0,
        nextRetryMs: 0,
        errorCode: null,
      },
      'Binance local order book synchronized',
    );
  }

  private cancelOrderBookSyncRetry(): void {
    if (this.orderBookSyncTimer) clearTimeout(this.orderBookSyncTimer);
    this.orderBookSyncTimer = null;
  }

  private markOrderBookUnsynchronized(
    syncState: ReturnType<LocalOrderBook['view']>['syncState'],
  ): void {
    this.cache.markDepthUnsynchronized(syncState);
  }

  private scheduleOrderBookSync(socket: WebSocket, delayMs = 0): void {
    if (this.stopping || this.sockets.public !== socket) return;
    if (this.orderBookSyncPromise || this.orderBookSyncTimer) return;
    if (delayMs > 0) {
      this.localOrderBook.markRetryScheduled();
      this.markOrderBookUnsynchronized('RETRY_SCHEDULED');
      this.orderBookSyncTimer = setTimeout(() => {
        this.orderBookSyncTimer = null;
        if (!this.stopping && this.sockets.public === socket)
          void this.synchronizeOrderBook(socket);
      }, delayMs);
      return;
    }
    this.localOrderBook.markFetchingSnapshot();
    this.markOrderBookUnsynchronized('FETCHING_SNAPSHOT');
    void this.synchronizeOrderBook(socket);
  }

  private orderBookErrorCode(error: unknown): string {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z0-9_]{1,100}$/.test(error.code)
    )
      return error.code;
    return 'DEPTH_SNAPSHOT_REQUEST_FAILED';
  }

  private orderBookRetryDetails(
    errorCode: string,
  ): { attempt: number; nextRetryMs: number } {
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
    this.localOrderBook.markRetryScheduled();
    this.markOrderBookUnsynchronized('RETRY_SCHEDULED');
    this.cache.recordSourceError('depth', errorCode);
    logger.warn(
      {
        ...this.localOrderBook.diagnostics(),
        attempt,
        nextRetryMs,
        errorCode,
      },
      'Binance local order book resync retry scheduled',
    );
    return { attempt, nextRetryMs };
  }

  private synchronizeOrderBook(socket: WebSocket): Promise<void> {
    if (this.orderBookSyncPromise) return this.orderBookSyncPromise;
    let pendingRetryMs: number | null = null;
    this.orderBookSyncPromise = (async () => {
      const snapshot = await this.dependencies.fetchOrderBook(1000);
      if (this.stopping || this.sockets.public !== socket) return;
      const result = this.localOrderBook.initialize({
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
      if (result === 'SNAPSHOT_STALE') {
        const error = new Error('Depth snapshot is older than buffered events');
        Object.assign(error, { code: 'DEPTH_SNAPSHOT_STALE' });
        throw error;
      }
      if (result === 'WAITING_FOR_BRIDGE') {
        this.markOrderBookUnsynchronized('WAITING_FOR_BRIDGE');
        logger.info(
          {
            ...this.localOrderBook.diagnostics(),
            attempt: this.orderBookSyncAttempt,
            nextRetryMs: 0,
            errorCode: null,
          },
          'Binance local order book waiting for bridge event',
        );
        return;
      }
      if (this.stopping || this.sockets.public !== socket) return;
      this.completeOrderBookSynchronization(
        snapshot.T ?? snapshot.E ?? Date.now(),
        Date.now(),
      );
    })()
      .catch((error: unknown) => {
        if (this.stopping || this.sockets.public !== socket) return;
        const errorCode = this.orderBookErrorCode(error);
        pendingRetryMs = this.orderBookRetryDetails(errorCode).nextRetryMs;
      })
      .finally(() => {
        this.orderBookSyncPromise = null;
        if (pendingRetryMs !== null)
          this.scheduleOrderBookSync(socket, pendingRetryMs);
      });
    return this.orderBookSyncPromise;
  }

  private connect(channel: MarketStreamChannel, runId: number): void {
    if (!this.isRunActive(runId)) return;
    let socket: WebSocket;
    try {
      socket = this.dependencies.createSocket(WS_URLS[channel]);
    } catch (error) {
      this.cache.setStreamConnected(channel, false, 'SOCKET_CREATE_FAILED');
      logger.warn(
        { channel, ...safeErrorDetails(error) },
        'Binance WebSocket creation failed',
      );
      this.scheduleReconnect(channel, runId);
      return;
    }
    this.sockets[channel] = socket;
    socket.addEventListener('open', () => {
      if (!this.isRunActive(runId) || this.sockets[channel] !== socket) return;
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
      if (!this.isRunActive(runId) || this.sockets[channel] !== socket) return;
      const receivedAt = Date.now();
      try {
        this.handleMessage(String(event.data), receivedAt);
        this.cache.markStreamEvent(channel, receivedAt);
      } catch (error) {
        logger.warn(
          { channel, ...safeErrorDetails(error) },
          'Binance WebSocket schema validation failed',
        );
      }
    });
    socket.addEventListener('error', () => {
      this.failSocket(channel, socket, runId, 'SOCKET_ERROR');
    });
    socket.addEventListener('close', () => {
      this.failSocket(channel, socket, runId, 'SOCKET_CLOSED', false);
    });
  }

  private failSocket(
    channel: MarketStreamChannel,
    socket: WebSocket,
    runId: number,
    errorCode: string,
    closeSocket = true,
  ): void {
    if (!this.isRunActive(runId) || this.sockets[channel] !== socket) return;
    const planned = this.plannedReconnectTimers[channel];
    if (planned) clearTimeout(planned);
    this.plannedReconnectTimers[channel] = null;
    this.sockets[channel] = null;
    if (channel === 'public') {
      this.cancelOrderBookSyncRetry();
      this.orderBookSyncAttempt = 0;
      this.cache.markDepthUnsynchronized();
    }
    this.cache.setStreamConnected(channel, false, errorCode);
    logger.warn({ channel, errorCode }, 'Binance WebSocket disconnected');
    if (closeSocket)
      try {
        socket.close();
      } catch {
        // The reconnect timer below is authoritative even if close throws.
      }
    this.scheduleReconnect(channel, runId);
  }

  private async refreshReferenceTimeframe(
    timeframe: (typeof REFERENCE_TIMEFRAMES)[number],
    runId: number,
  ): Promise<void> {
    const tuples = await this.dependencies.fetchKlines('BTCUSDT', timeframe, 251);
    if (!this.isRunActive(runId)) return;
    this.applyRestCandles(timeframe, tuples);
    this.cache.clearSourceError(`candle:${timeframe}`);
  }

  private async refreshReferenceCandles(runId: number): Promise<void> {
    await Promise.allSettled(
      REFERENCE_TIMEFRAMES.map(async (timeframe) => {
        try {
          await this.refreshReferenceTimeframe(timeframe, runId);
        } catch (error) {
          if (!this.isRunActive(runId)) return;
          this.cache.recordSourceError(
            `candle:${timeframe}`,
            `REFERENCE_CANDLE_REST_FAILED_${timeframe}`,
          );
          logger.warn(
            { timeframe, ...safeErrorDetails(error) },
            'Reference candle REST refresh failed',
          );
        }
      }),
    );
  }

  private scheduleReconnect(channel: MarketStreamChannel, runId: number): void {
    if (!this.isRunActive(runId) || this.reconnectTimers[channel]) return;
    const base = Math.min(
      30_000,
      1_000 * 2 ** this.reconnectAttempts[channel],
    );
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts[channel] += 1;
    this.reconnectTimers[channel] = setTimeout(() => {
      this.reconnectTimers[channel] = null;
      if (!this.isRunActive(runId)) return;
      this.connect(channel, runId);
      if (channel === 'market') void this.refreshCandles(runId);
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
      this.cache.clearSourceError('market');
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
      this.cache.clearSourceError('bookTicker');
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
      else if (result === 'SYNCHRONIZED')
        this.completeOrderBookSynchronization(event.E, receivedAt);
      else if (result === 'GAP' || result === 'SNAPSHOT_STALE') {
        const socket = this.sockets.public;
        if (socket) {
          const errorCode =
            result === 'GAP'
              ? 'DEPTH_UPDATE_ID_GAP'
              : 'DEPTH_SNAPSHOT_STALE';
          const retry = this.orderBookRetryDetails(errorCode);
          this.scheduleOrderBookSync(socket, retry.nextRetryMs);
        }
      } else if (result === 'BUFFERED') {
        const socket = this.sockets.public;
        if (
          socket &&
          this.localOrderBook.view(1).syncState === 'FETCHING_SNAPSHOT' &&
          !this.orderBookSyncPromise
        )
          this.scheduleOrderBookSync(socket);
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
