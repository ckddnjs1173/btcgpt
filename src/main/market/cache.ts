import type { DataStatus } from '../../shared/contracts';
import {
  SYMBOL,
  TIMEFRAMES,
  type Candle,
  type DepthState,
  type LiquidationEvent,
  type ProductFilters,
  type PublicMarketState,
  type SentimentState,
  type SourceHealth,
  type Timeframe,
  type TradeEvent,
} from './types';

const MAX_CANDLES = 500;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;

export class MarketCache {
  private readonly closed = new Map<Timeframe, Map<number, Candle>>(
    TIMEFRAMES.map((timeframe) => [timeframe, new Map()]),
  );
  private readonly live = new Map<Timeframe, Candle>();
  private readonly sourceTimes = new Map<
    string,
    { eventTime: number; receivedAt: number }
  >();
  private readonly trades: TradeEvent[] = [];
  private readonly liquidations: LiquidationEvent[] = [];
  private reconnectCount = 0;
  private lastEventAt: number | null = null;
  private connected = false;
  private message: string | null = null;
  private validationError: string | null = null;
  private consecutiveFailures = 0;

  readonly depth: DepthState = {
    bids: [],
    asks: [],
    eventTime: null,
    receivedAt: null,
  };
  productFilters: ProductFilters | null = null;
  readonly sentiment: SentimentState = {
    globalLongShortAccountRatio: null,
    topLongShortAccountRatio: null,
    topLongShortPositionRatio: null,
    takerBuySellRatio: null,
    openInterestChanges: {},
    updatedAt: null,
  };
  readonly state: PublicMarketState = {
    lastPrice: null,
    markPrice: null,
    indexPrice: null,
    fundingRate: null,
    nextFundingTime: null,
    bidPrice: null,
    askPrice: null,
    openInterest: null,
    updatedAt: null,
    priceChangePercent24h: null,
    highPrice24h: null,
    lowPrice24h: null,
    volume24h: null,
    quoteVolume24h: null,
  };

  upsertCandle(candle: Candle): void {
    this.markSource(
      `candle:${candle.timeframe}`,
      candle.eventTime ?? candle.receivedAt,
      candle.receivedAt,
    );
    if (!candle.isClosed) {
      this.live.set(candle.timeframe, candle);
      return;
    }
    this.live.delete(candle.timeframe);
    const bucket = this.closed.get(candle.timeframe);
    if (!bucket) return;
    bucket.set(candle.openTime, candle);
    const keys = [...bucket.keys()].sort((a, b) => a - b);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CANDLES))) {
      bucket.delete(key);
    }
  }

  getClosed(timeframe: Timeframe): Candle[] {
    return [...(this.closed.get(timeframe)?.values() ?? [])].sort(
      (a, b) => a.openTime - b.openTime,
    );
  }

  getLive(timeframe: Timeframe): Candle | null {
    return this.live.get(timeframe) ?? null;
  }

  setConnected(connected: boolean, message: string | null = null): void {
    if (connected && !this.connected) this.reconnectCount += 1;
    this.connected = connected;
    this.message = message;
    if (connected) {
      this.lastEventAt = Date.now();
      this.consecutiveFailures = 0;
      this.validationError = null;
    } else {
      this.consecutiveFailures += 1;
    }
  }

  updateState(
    values: Partial<PublicMarketState>,
    receivedAt = Date.now(),
    source = 'market',
    eventTime = receivedAt,
  ): void {
    Object.assign(this.state, values, { updatedAt: receivedAt });
    this.markSource(source, eventTime, receivedAt);
  }

  setProductFilters(filters: ProductFilters): void {
    this.productFilters = filters;
  }

  updateDepth(
    bids: Array<[number, number]>,
    asks: Array<[number, number]>,
    eventTime: number,
    receivedAt = Date.now(),
  ): void {
    Object.assign(this.depth, { bids, asks, eventTime, receivedAt });
    this.markSource('depth', eventTime, receivedAt);
  }

  addTrade(event: TradeEvent): void {
    if (
      event.id !== undefined &&
      this.trades.some((candidate) => candidate.id === event.id)
    )
      return;
    this.trades.push(event);
    this.pruneEvents(event.receivedAt);
    this.markSource('trades', event.eventTime, event.receivedAt);
  }

  addLiquidation(event: LiquidationEvent): void {
    this.liquidations.push(event);
    this.pruneEvents(event.receivedAt);
    this.markSource('liquidations', event.eventTime, event.receivedAt);
  }

  updateSentiment(
    values: Partial<SentimentState>,
    receivedAt = Date.now(),
  ): void {
    Object.assign(this.sentiment, values, { updatedAt: receivedAt });
    this.markSource('statistics', receivedAt, receivedAt);
  }

  recordValidationError(message: string): void {
    this.validationError = message;
    this.consecutiveFailures += 1;
  }

  getTrades(windowMs: number, now = Date.now()): TradeEvent[] {
    return this.trades.filter((event) => event.eventTime >= now - windowMs);
  }

  getLiquidations(windowMs: number, now = Date.now()): LiquidationEvent[] {
    return this.liquidations.filter(
      (event) => event.eventTime >= now - windowMs,
    );
  }

  sourceHealth(now = Date.now()): Record<string, SourceHealth> {
    const thresholds: Record<string, [number, number]> = {
      market: [6_000, 15_000],
      depth: [1_000, 3_000],
      bookTicker: [1_000, 3_000],
      trades: [6_000, 15_000],
      openInterest: [30_000, 90_000],
      liquidations: [60_000, 300_000],
      statistics: [300_000, 900_000],
      'candle:5m': [20_000, 45_000],
      'candle:15m': [20_000, 45_000],
      'candle:1h': [20_000, 45_000],
      'candle:4h': [20_000, 45_000],
    };
    return Object.fromEntries(
      Object.entries(thresholds).map(([source, [delayed, stale]]) => {
        const time = this.sourceTimes.get(source);
        const ageMs = time ? now - time.receivedAt : Number.POSITIVE_INFINITY;
        const status: DataStatus = !this.connected
          ? 'DISCONNECTED'
          : !time
            ? 'INSUFFICIENT_DATA'
            : ageMs > stale
              ? 'STALE'
              : ageMs > delayed
                ? 'DELAYED'
                : 'NORMAL';
        return [
          source,
          {
            status,
            lastEventAt: time?.eventTime ?? null,
            eventTime: time?.eventTime ?? null,
            receivedTime: time?.receivedAt ?? null,
            lastSuccess: time?.receivedAt ?? null,
            ageMs,
            reconnectCount: Math.max(0, this.reconnectCount - 1),
            consecutiveFailures: this.consecutiveFailures,
            validationError: this.validationError,
            message: this.message,
          },
        ];
      }),
    );
  }

  health(now = Date.now()): SourceHealth {
    const sources = this.sourceHealth(now);
    const required = [
      'market',
      'depth',
      'bookTicker',
      'trades',
      'openInterest',
      ...TIMEFRAMES.map((timeframe) => `candle:${timeframe}`),
    ];
    const statuses = required.map(
      (source) => sources[source]?.status ?? 'INSUFFICIENT_DATA',
    );
    let status: DataStatus;
    if (!this.connected) status = 'DISCONNECTED';
    else if (TIMEFRAMES.some((tf) => this.getClosed(tf).length < 250))
      status = 'INSUFFICIENT_DATA';
    else if (statuses.some((value) => value === 'STALE')) status = 'STALE';
    else if (statuses.some((value) => value === 'INSUFFICIENT_DATA'))
      status = 'INSUFFICIENT_DATA';
    else if (statuses.some((value) => value === 'DELAYED')) status = 'DELAYED';
    else status = 'NORMAL';
    const ageMs =
      this.lastEventAt === null
        ? Number.POSITIVE_INFINITY
        : now - this.lastEventAt;
    return {
      status,
      lastEventAt: this.lastEventAt,
      eventTime: this.lastEventAt,
      receivedTime: this.lastEventAt,
      lastSuccess: this.lastEventAt,
      ageMs,
      reconnectCount: Math.max(0, this.reconnectCount - 1),
      consecutiveFailures: this.consecutiveFailures,
      validationError: this.validationError,
      message: this.message,
    };
  }

  status() {
    const health = this.health();
    return {
      symbol: SYMBOL,
      lastSnapshotAt: this.state.updatedAt,
      markPrice:
        this.state.markPrice === null ? null : String(this.state.markPrice),
      indexPrice:
        this.state.indexPrice === null ? null : String(this.state.indexPrice),
      timeframeCounts: Object.fromEntries(
        TIMEFRAMES.map((tf) => [tf, this.getClosed(tf).length]),
      ) as Record<Timeframe, number>,
      dataStatus: health.status,
    };
  }

  private markSource(
    source: string,
    eventTime: number,
    receivedAt: number,
  ): void {
    this.sourceTimes.set(source, { eventTime, receivedAt });
    this.lastEventAt = receivedAt;
  }

  private pruneEvents(now: number): void {
    const cutoff = now - FOUR_HOURS_MS;
    while ((this.trades[0]?.eventTime ?? now) < cutoff) this.trades.shift();
    while ((this.liquidations[0]?.eventTime ?? now) < cutoff)
      this.liquidations.shift();
  }
}
