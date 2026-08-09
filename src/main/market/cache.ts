import type { DataStatus } from '../../shared/contracts';
import {
  SYMBOL,
  REFERENCE_TIMEFRAMES,
  TIMEFRAMES,
  type Candle,
  type DepthState,
  type DepthSample,
  type LiquidationEvent,
  type OpenInterestSample,
  type ProductFilters,
  type PublicMarketState,
  type SentimentState,
  type SourceHealth,
  type Timeframe,
  type TradeEvent,
  type WebSocketHealth,
} from './types';

const MAX_CANDLES = 500;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;
export type MarketStreamChannel = 'public' | 'market';

export class MarketCache {
  private readonly closed = new Map<Timeframe, Map<number, Candle>>(
    [...TIMEFRAMES, ...REFERENCE_TIMEFRAMES].map((timeframe) => [
      timeframe,
      new Map(),
    ]),
  );
  private readonly live = new Map<Timeframe, Candle>();
  private readonly sourceTimes = new Map<
    string,
    { eventTime: number; receivedAt: number }
  >();
  private readonly trades: TradeEvent[] = [];
  private sessionCvd = 0;
  private sessionCvdStartedAt: number | null = null;
  private readonly liquidations: LiquidationEvent[] = [];
  private readonly depthSamples: DepthSample[] = [];
  private readonly openInterestSamples: OpenInterestSample[] = [];
  private lastEventAt: number | null = null;
  private message: string | null = null;
  private validationError: string | null = null;
  private consecutiveFailures = 0;
  private readonly sourceErrors = new Map<
    string,
    { validationError: string; consecutiveFailures: number }
  >();
  private readonly streamStates: Record<
    MarketStreamChannel,
    {
      connected: boolean;
      lastConnectedAt: number | null;
      lastEventAt: number | null;
      reconnectCount: number;
      consecutiveFailures: number;
      errorCode: string | null;
    }
  > = {
    public: {
      connected: false,
      lastConnectedAt: null,
      lastEventAt: null,
      reconnectCount: 0,
      consecutiveFailures: 0,
      errorCode: null,
    },
    market: {
      connected: false,
      lastConnectedAt: null,
      lastEventAt: null,
      reconnectCount: 0,
      consecutiveFailures: 0,
      errorCode: null,
    },
  };

  readonly depth: DepthState = {
    bids: [],
    asks: [],
    eventTime: null,
    receivedAt: null,
    synchronized: false,
    syncState: 'FETCHING_SNAPSHOT',
    lastUpdateId: null,
    levelCount: 0,
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
    this.clearSourceError(`candle:${candle.timeframe}`);
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
    this.setStreamConnected('public', connected, message);
    this.setStreamConnected('market', connected, message);
  }

  setStreamConnected(
    channel: MarketStreamChannel,
    connected: boolean,
    errorCode: string | null = null,
  ): void {
    const state = this.streamStates[channel];
    if (connected && !state.connected) state.reconnectCount += 1;
    state.connected = connected;
    if (connected) {
      state.lastConnectedAt = Date.now();
      state.consecutiveFailures = 0;
      state.errorCode = null;
    } else {
      state.consecutiveFailures += 1;
      state.errorCode = errorCode;
    }
  }

  markStreamEvent(channel: MarketStreamChannel, receivedAt: number): void {
    this.streamStates[channel].lastEventAt = receivedAt;
    this.lastEventAt = receivedAt;
  }

  connectionHealth(): Record<MarketStreamChannel, WebSocketHealth> {
    return Object.fromEntries(
      (['public', 'market'] as const).map((channel) => {
        const state = this.streamStates[channel];
        return [
          channel,
          {
            status: state.connected ? 'CONNECTED' : 'DISCONNECTED',
            connected: state.connected,
            lastConnectedAt: state.lastConnectedAt,
            lastEventAt: state.lastEventAt,
            reconnectCount: Math.max(0, state.reconnectCount - 1),
            consecutiveFailures: state.consecutiveFailures,
            errorCode: state.errorCode,
          },
        ];
      }),
    ) as Record<MarketStreamChannel, WebSocketHealth>;
  }

  updateState(
    values: Partial<PublicMarketState>,
    receivedAt = Date.now(),
    source = 'market',
    eventTime = receivedAt,
  ): void {
    Object.assign(this.state, values, { updatedAt: receivedAt });
    if (
      source === 'openInterest' &&
      values.openInterest !== undefined &&
      values.openInterest !== null
    ) {
      this.openInterestSamples.push({
        observedAt: receivedAt,
        value: values.openInterest,
      });
      this.pruneSamples(receivedAt);
    }
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
    synchronization: {
      synchronized: boolean;
      lastUpdateId: number | null;
      levelCount: number;
    } = {
      synchronized: false,
      lastUpdateId: null,
      levelCount: Math.min(bids.length, asks.length),
    },
  ): void {
    Object.assign(this.depth, {
      bids,
      asks,
      eventTime,
      receivedAt,
      ...synchronization,
      syncState: synchronization.synchronized
        ? 'SYNCHRONIZED'
        : this.depth.syncState,
    });
    const wall = (levels: Array<[number, number]>) =>
      levels
        .slice(0, 20)
        .map(([price, quantity]) => ({
          price,
          notional: price * quantity,
        }))
        .sort((a, b) => b.notional - a.notional)[0] ?? null;
    const bidNotional = bids
      .slice(0, 20)
      .reduce((sum, [price, quantity]) => sum + price * quantity, 0);
    const askNotional = asks
      .slice(0, 20)
      .reduce((sum, [price, quantity]) => sum + price * quantity, 0);
    const total = bidNotional + askNotional;
    const bidWall = wall(bids);
    const askWall = wall(asks);
    this.depthSamples.push({
      observedAt: receivedAt,
      imbalance20: total > 0 ? (bidNotional - askNotional) / total : null,
      bidWallPrice: bidWall?.price ?? null,
      bidWallNotional: bidWall?.notional ?? null,
      askWallPrice: askWall?.price ?? null,
      askWallNotional: askWall?.notional ?? null,
    });
    this.pruneSamples(receivedAt);
    this.markSource('depth', eventTime, receivedAt);
    if (synchronization.synchronized) this.clearSourceError('depth');
  }

  markDepthUnsynchronized(
    syncState: DepthState['syncState'] = 'FETCHING_SNAPSHOT',
  ): void {
    this.depth.synchronized = false;
    this.depth.syncState = syncState;
  }

  addTrade(event: TradeEvent): void {
    if (
      event.id !== undefined &&
      this.trades.some((candidate) => candidate.id === event.id)
    )
      return;
    this.trades.push(event);
    if (this.sessionCvdStartedAt === null)
      this.sessionCvdStartedAt = event.eventTime;
    this.sessionCvd += event.buyerIsMaker ? -event.quantity : event.quantity;
    this.pruneEvents(event.receivedAt);
    this.markSource('trades', event.eventTime, event.receivedAt);
    this.clearSourceError('trades');
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

  recordSourceError(source: string, validationError: string): void {
    const current = this.sourceErrors.get(source);
    this.sourceErrors.set(source, {
      validationError,
      consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
    });
  }

  clearSourceError(source: string): void {
    this.sourceErrors.delete(source);
  }

  getTrades(windowMs: number, now = Date.now()): TradeEvent[] {
    return this.trades.filter((event) => event.eventTime >= now - windowMs);
  }

  getSessionCvd(): { value: number; startedAt: number | null } {
    return {
      value: this.sessionCvd,
      startedAt: this.sessionCvdStartedAt,
    };
  }

  getLiquidations(windowMs: number, now = Date.now()): LiquidationEvent[] {
    return this.liquidations.filter(
      (event) => event.eventTime >= now - windowMs,
    );
  }

  getDepthSamples(windowMs: number, now = Date.now()): DepthSample[] {
    return this.depthSamples.filter(
      (sample) => sample.observedAt >= now - windowMs,
    );
  }

  getOpenInterestSamples(
    windowMs: number,
    now = Date.now(),
  ): OpenInterestSample[] {
    return this.openInterestSamples.filter(
      (sample) => sample.observedAt >= now - windowMs,
    );
  }

  sourceHealth(now = Date.now()): Record<string, SourceHealth> {
    const thresholds: Record<string, [number, number]> = {
      market: [2_000, 5_000],
      depth: [1_000, 3_000],
      bookTicker: [1_000, 3_000],
      trades: [3_000, 10_000],
      openInterest: [30_000, 90_000],
      liquidations: [60_000, 300_000],
      statistics: [300_000, 900_000],
      'candle:5m': [20_000, 45_000],
      'candle:1m': [20_000, 45_000],
      'candle:3m': [20_000, 45_000],
      'candle:15m': [20_000, 45_000],
      'candle:30m': [20_000, 45_000],
      'candle:1h': [20_000, 45_000],
      'candle:4h': [20_000, 45_000],
      'candle:1d': [12 * 60 * 60_000, 36 * 60 * 60_000],
      'candle:1w': [12 * 60 * 60_000, 36 * 60 * 60_000],
    };
    const sources: Record<string, SourceHealth> = Object.fromEntries(
      Object.entries(thresholds).map(([source, [delayed, stale]]) => {
        const time = this.sourceTimes.get(source);
        const ageMs = time ? now - time.receivedAt : Number.POSITIVE_INFINITY;
        const sourceError = this.sourceErrors.get(source);
        const status: DataStatus = !time
            ? 'INSUFFICIENT_DATA'
            : ageMs > stale
              ? 'STALE'
              : sourceError
                ? 'DELAYED'
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
            reconnectCount: 0,
            consecutiveFailures: sourceError?.consecutiveFailures ?? 0,
            validationError: sourceError?.validationError ?? null,
            message: this.message,
          },
        ];
      }),
    );
    for (const [source, sourceError] of this.sourceErrors) {
      if (sources[source]) continue;
      sources[source] = {
        status: 'DELAYED',
        lastEventAt: null,
        eventTime: null,
        receivedTime: null,
        lastSuccess: null,
        ageMs: Number.POSITIVE_INFINITY,
        reconnectCount: 0,
        consecutiveFailures: sourceError.consecutiveFailures,
        validationError: sourceError.validationError,
        message: this.message,
      };
    }
    for (const channel of ['public', 'market'] as const) {
      const stream = this.streamStates[channel];
      const eventTime = stream.lastEventAt ?? stream.lastConnectedAt;
      sources[`websocket:${channel}`] = {
        status: stream.connected ? 'NORMAL' : 'DISCONNECTED',
        lastEventAt: eventTime,
        eventTime,
        receivedTime: stream.lastEventAt,
        lastSuccess: stream.lastConnectedAt,
        ageMs: eventTime === null ? Number.POSITIVE_INFINITY : now - eventTime,
        reconnectCount: Math.max(0, stream.reconnectCount - 1),
        consecutiveFailures: stream.consecutiveFailures,
        validationError: stream.errorCode,
        message: stream.errorCode,
      };
    }
    return sources;
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
    if (TIMEFRAMES.some((tf) => this.getClosed(tf).length < 250))
      status = 'INSUFFICIENT_DATA';
    else if (statuses.some((value) => value === 'DISCONNECTED'))
      status = 'DISCONNECTED';
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
      reconnectCount:
        Math.max(0, this.streamStates.public.reconnectCount - 1) +
        Math.max(0, this.streamStates.market.reconnectCount - 1),
      consecutiveFailures:
        this.consecutiveFailures +
        this.streamStates.public.consecutiveFailures +
        this.streamStates.market.consecutiveFailures,
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

  private pruneSamples(now: number): void {
    const depthCutoff = now - 35_000;
    while (
      this.depthSamples.length > 0 &&
      (this.depthSamples[0]?.observedAt ?? now) < depthCutoff
    )
      this.depthSamples.shift();
    const oiCutoff = now - 6 * 60_000;
    while (
      this.openInterestSamples.length > 0 &&
      (this.openInterestSamples[0]?.observedAt ?? now) < oiCutoff
    )
      this.openInterestSamples.shift();
  }
}
