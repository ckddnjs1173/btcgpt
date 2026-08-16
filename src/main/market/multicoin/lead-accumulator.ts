import {
  leadAssetObservationSchema,
  type EvidenceCoverage,
  type EvidenceStatus,
  type LeadAssetObservation,
} from '../../../shared/market-intelligence';
import {
  classifyEvidenceAge,
  MULTICOIN_FRESHNESS_THRESHOLDS,
} from '../intelligence/freshness';
import { buildDataProvenance } from '../intelligence/provenance';

export type LeadSymbol = 'ETHUSDT' | 'SOLUSDT';

const RETURN_WINDOWS_MS = {
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
} as const;

const FLOW_WINDOWS_MS = {
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
} as const;

const OI_WINDOWS_MS = {
  '30s': 30_000,
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
} as const;

const MAX_TRADE_HISTORY_MS = 65 * 60_000;
const MAX_OI_HISTORY_MS = 16 * 60_000;
const MAX_LIQUIDATION_HISTORY_MS = 16 * 60_000;
const RETURN_REFERENCE_MAX_GAP_MS = 5_000;
const OI_REFERENCE_MAX_GAP_MS = 20_000;

type TradeBucket = {
  second: number;
  lastPrice: number;
  buyNotional: number;
  sellNotional: number;
  count: number;
  lastEventAt: number;
  lastReceivedAt: number;
};

type OpenInterestPoint = {
  at: number;
  receivedAt: number;
  openInterest: number;
};

type LiquidationEvent = {
  at: number;
  receivedAt: number;
  longNotional: number;
  shortNotional: number;
};

type BookState = {
  bidPrice: number | null;
  bidQuantity: number | null;
  askPrice: number | null;
  askQuantity: number | null;
  eventAt: number | null;
  receivedAt: number | null;
};

type DepthState = {
  bidNotional20: number;
  askNotional20: number;
  depthImbalance20: number | null;
  microPrice: number | null;
  eventAt: number | null;
  receivedAt: number | null;
};

type MarkState = {
  markPrice: number | null;
  indexPrice: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  eventAt: number | null;
  receivedAt: number | null;
};

type ClosedOneMinuteCandle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  tradeCount: number;
  takerBuyQuoteVolume: number;
  closed: true;
};

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function bpsChange(current: number, previous: number): number | null {
  if (!finitePositive(current) || !finitePositive(previous)) return null;
  return ((current - previous) / previous) * 10_000;
}

function percentChange(current: number, previous: number): number | null {
  if (!finiteNonNegative(current) || !finitePositive(previous)) return null;
  return ((current - previous) / previous) * 100;
}

function sourceStatus(
  ageMs: number | null,
  threshold: (typeof MULTICOIN_FRESHNESS_THRESHOLDS)[keyof typeof MULTICOIN_FRESHNESS_THRESHOLDS],
): EvidenceStatus {
  return classifyEvidenceAge(ageMs, threshold);
}

export class LeadAssetAccumulator {
  private readonly tradeBuckets = new Map<number, TradeBucket>();
  private readonly openInterestHistory: OpenInterestPoint[] = [];
  private readonly liquidationEvents: LiquidationEvent[] = [];
  private cumulativeDeltaNotional = 0;
  private lastPrice: number | null = null;
  private lastPriceEventAt: number | null = null;
  private lastPriceReceivedAt: number | null = null;
  private latestClosed1m: ClosedOneMinuteCandle | null = null;
  private readonly book: BookState = {
    bidPrice: null,
    bidQuantity: null,
    askPrice: null,
    askQuantity: null,
    eventAt: null,
    receivedAt: null,
  };
  private readonly depth: DepthState = {
    bidNotional20: 0,
    askNotional20: 0,
    depthImbalance20: null,
    microPrice: null,
    eventAt: null,
    receivedAt: null,
  };
  private readonly mark: MarkState = {
    markPrice: null,
    indexPrice: null,
    fundingRate: null,
    nextFundingTime: null,
    eventAt: null,
    receivedAt: null,
  };

  constructor(readonly symbol: LeadSymbol) {}

  resetPublicStream(): void {
    this.book.bidPrice = null;
    this.book.bidQuantity = null;
    this.book.askPrice = null;
    this.book.askQuantity = null;
    this.book.eventAt = null;
    this.book.receivedAt = null;
    this.depth.bidNotional20 = 0;
    this.depth.askNotional20 = 0;
    this.depth.depthImbalance20 = null;
    this.depth.microPrice = null;
    this.depth.eventAt = null;
    this.depth.receivedAt = null;
  }

  resetMarketStream(): void {
    this.tradeBuckets.clear();
    this.liquidationEvents.length = 0;
    this.cumulativeDeltaNotional = 0;
    this.lastPrice = null;
    this.lastPriceEventAt = null;
    this.lastPriceReceivedAt = null;
    this.latestClosed1m = null;
    this.mark.markPrice = null;
    this.mark.indexPrice = null;
    this.mark.fundingRate = null;
    this.mark.nextFundingTime = null;
    this.mark.eventAt = null;
    this.mark.receivedAt = null;
  }

  recordTrade(input: {
    price: number;
    quantity: number;
    buyerIsMaker: boolean;
    eventAt: number;
    receivedAt: number;
  }): void {
    if (!finitePositive(input.price) || !finitePositive(input.quantity)) return;
    const second = Math.floor(input.eventAt / 1_000) * 1_000;
    const notional = input.price * input.quantity;
    const buyNotional = input.buyerIsMaker ? 0 : notional;
    const sellNotional = input.buyerIsMaker ? notional : 0;
    const current = this.tradeBuckets.get(second);
    if (current) {
      current.lastPrice = input.price;
      current.buyNotional += buyNotional;
      current.sellNotional += sellNotional;
      current.count += 1;
      current.lastEventAt = Math.max(current.lastEventAt, input.eventAt);
      current.lastReceivedAt = Math.max(
        current.lastReceivedAt,
        input.receivedAt,
      );
    } else {
      this.tradeBuckets.set(second, {
        second,
        lastPrice: input.price,
        buyNotional,
        sellNotional,
        count: 1,
        lastEventAt: input.eventAt,
        lastReceivedAt: input.receivedAt,
      });
    }
    this.cumulativeDeltaNotional += buyNotional - sellNotional;
    this.updateLastPrice(input.price, input.eventAt, input.receivedAt);
    this.prune(input.receivedAt);
  }

  recordClosedOneMinuteCandle(input: ClosedOneMinuteCandle): void {
    if (
      !finitePositive(input.open) ||
      !finitePositive(input.high) ||
      !finitePositive(input.low) ||
      !finitePositive(input.close) ||
      !finiteNonNegative(input.volume) ||
      !finiteNonNegative(input.quoteVolume) ||
      !finiteNonNegative(input.takerBuyQuoteVolume) ||
      !Number.isInteger(input.tradeCount) ||
      input.tradeCount < 0 ||
      input.closeTime < input.openTime
    )
      return;
    if (
      this.latestClosed1m !== null &&
      input.closeTime < this.latestClosed1m.closeTime
    )
      return;
    this.latestClosed1m = { ...input, closed: true };
  }

  recordBookTicker(input: {
    bidPrice: number;
    bidQuantity: number;
    askPrice: number;
    askQuantity: number;
    eventAt: number;
    receivedAt: number;
  }): void {
    if (
      !finitePositive(input.bidPrice) ||
      !finitePositive(input.askPrice) ||
      !finiteNonNegative(input.bidQuantity) ||
      !finiteNonNegative(input.askQuantity)
    )
      return;
    this.book.bidPrice = input.bidPrice;
    this.book.bidQuantity = input.bidQuantity;
    this.book.askPrice = input.askPrice;
    this.book.askQuantity = input.askQuantity;
    this.book.eventAt = input.eventAt;
    this.book.receivedAt = input.receivedAt;
  }

  recordDepth(input: {
    bids: Array<[number, number]>;
    asks: Array<[number, number]>;
    eventAt: number;
    receivedAt: number;
  }): void {
    const bids = input.bids
      .filter(
        ([price, quantity]) =>
          finitePositive(price) && finiteNonNegative(quantity),
      )
      .slice(0, 20);
    const asks = input.asks
      .filter(
        ([price, quantity]) =>
          finitePositive(price) && finiteNonNegative(quantity),
      )
      .slice(0, 20);
    if (bids.length === 0 || asks.length === 0) return;

    const bidNotional20 = bids.reduce(
      (sum, [price, quantity]) => sum + price * quantity,
      0,
    );
    const askNotional20 = asks.reduce(
      (sum, [price, quantity]) => sum + price * quantity,
      0,
    );
    const totalNotional = bidNotional20 + askNotional20;
    const bestBid = bids[0];
    const bestAsk = asks[0];
    const bestQuantity = (bestBid?.[1] ?? 0) + (bestAsk?.[1] ?? 0);

    this.depth.bidNotional20 = bidNotional20;
    this.depth.askNotional20 = askNotional20;
    this.depth.depthImbalance20 =
      totalNotional > 0
        ? (bidNotional20 - askNotional20) / totalNotional
        : null;
    this.depth.microPrice =
      bestBid && bestAsk && bestQuantity > 0
        ? (bestAsk[0] * bestBid[1] + bestBid[0] * bestAsk[1]) / bestQuantity
        : null;
    this.depth.eventAt = input.eventAt;
    this.depth.receivedAt = input.receivedAt;
  }

  recordMark(input: {
    markPrice: number;
    indexPrice: number;
    fundingRate: number;
    nextFundingTime: number;
    eventAt: number;
    receivedAt: number;
  }): void {
    if (!finitePositive(input.markPrice) || !finitePositive(input.indexPrice))
      return;
    this.mark.markPrice = input.markPrice;
    this.mark.indexPrice = input.indexPrice;
    this.mark.fundingRate = Number.isFinite(input.fundingRate)
      ? input.fundingRate
      : null;
    this.mark.nextFundingTime = Number.isFinite(input.nextFundingTime)
      ? Math.max(0, Math.trunc(input.nextFundingTime))
      : null;
    this.mark.eventAt = input.eventAt;
    this.mark.receivedAt = input.receivedAt;
  }

  recordOpenInterest(input: {
    openInterest: number;
    observedAt: number;
    receivedAt: number;
  }): void {
    if (!finiteNonNegative(input.openInterest)) return;
    const previous = this.openInterestHistory.at(-1);
    if (previous && input.observedAt < previous.at) return;
    if (previous && input.observedAt === previous.at) {
      this.openInterestHistory[this.openInterestHistory.length - 1] = {
        at: input.observedAt,
        receivedAt: input.receivedAt,
        openInterest: input.openInterest,
      };
    } else {
      this.openInterestHistory.push({
        at: input.observedAt,
        receivedAt: input.receivedAt,
        openInterest: input.openInterest,
      });
    }
    this.prune(input.receivedAt);
  }

  recordLiquidation(input: {
    side: 'BUY' | 'SELL';
    quantity: number;
    price: number;
    eventAt: number;
    receivedAt: number;
  }): void {
    if (!finitePositive(input.quantity) || !finitePositive(input.price)) return;
    const notional = input.quantity * input.price;
    this.liquidationEvents.push({
      at: input.eventAt,
      receivedAt: input.receivedAt,
      longNotional: input.side === 'SELL' ? notional : 0,
      shortNotional: input.side === 'BUY' ? notional : 0,
    });
    this.prune(input.receivedAt);
  }

  snapshot(now = Date.now()): LeadAssetObservation | null {
    this.prune(now);
    if (
      this.lastPrice === null &&
      this.mark.markPrice === null &&
      this.book.bidPrice === null
    )
      return null;

    const collectorReceivedAt = Math.max(
      this.lastPriceReceivedAt ?? 0,
      this.book.receivedAt ?? 0,
      this.depth.receivedAt ?? 0,
      this.mark.receivedAt ?? 0,
      this.openInterestHistory.at(-1)?.receivedAt ?? 0,
      this.liquidationEvents.at(-1)?.receivedAt ?? 0,
    );
    const sourceEventAt = Math.max(
      this.lastPriceEventAt ?? 0,
      this.book.eventAt ?? 0,
      this.depth.eventAt ?? 0,
      this.mark.eventAt ?? 0,
      this.openInterestHistory.at(-1)?.at ?? 0,
      this.liquidationEvents.at(-1)?.at ?? 0,
    );
    const currentPrice = this.lastPrice ?? this.mark.markPrice;
    const provenance = this.buildProvenance(now);
    const latestOi = this.openInterestHistory.at(-1) ?? null;

    return leadAssetObservationSchema.parse({
      symbol: this.symbol,
      baseAsset: this.symbol === 'ETHUSDT' ? 'ETH' : 'SOL',
      quoteAsset: 'USDT',
      venue: 'BINANCE_USDM',
      instrumentType: 'PERPETUAL',
      tier: 'LEAD_CORE',
      generatedAt: now,
      sourceEventAt: sourceEventAt > 0 ? sourceEventAt : null,
      collectorReceivedAt: collectorReceivedAt > 0 ? collectorReceivedAt : now,
      provenance,
      market: {
        lastPrice: this.lastPrice,
        markPrice: this.mark.markPrice,
        indexPrice: this.mark.indexPrice,
        bidPrice: this.book.bidPrice,
        askPrice: this.book.askPrice,
        spreadBps:
          this.book.bidPrice !== null && this.book.askPrice !== null
            ? bpsChange(this.book.askPrice, this.book.bidPrice)
            : null,
        fundingRate: this.mark.fundingRate,
        nextFundingTime: this.mark.nextFundingTime,
      },
      latestClosed1m: this.latestClosed1m,
      returnsBps: Object.fromEntries(
        Object.entries(RETURN_WINDOWS_MS).map(([window, duration]) => [
          window,
          currentPrice === null
            ? null
            : this.returnBps(currentPrice, now, duration),
        ]),
      ),
      tradeFlow: {
        ...Object.fromEntries(
          Object.entries(FLOW_WINDOWS_MS).map(([window, duration]) => [
            window,
            this.tradeFlow(now, duration),
          ]),
        ),
        cumulativeDeltaNotional: this.cumulativeDeltaNotional,
      },
      microstructure: {
        depthLevels: 20,
        bidNotional20: this.depth.bidNotional20,
        askNotional20: this.depth.askNotional20,
        depthImbalance20: this.depth.depthImbalance20,
        microPrice: this.depth.microPrice,
        depthObservedAt: this.depth.eventAt,
      },
      openInterest: {
        current: latestOi?.openInterest ?? null,
        notional:
          latestOi && currentPrice !== null
            ? latestOi.openInterest * currentPrice
            : null,
        observedAt: latestOi?.at ?? null,
        changesPercent: Object.fromEntries(
          Object.entries(OI_WINDOWS_MS).map(([window, duration]) => [
            window,
            this.openInterestChange(now, duration),
          ]),
        ),
      },
      liquidations: {
        '1m': this.liquidationWindow(now, 60_000),
        '5m': this.liquidationWindow(now, 5 * 60_000),
        '15m': this.liquidationWindow(now, 15 * 60_000),
      },
    });
  }

  private updateLastPrice(
    price: number,
    eventAt: number,
    receivedAt: number,
  ): void {
    if (this.lastPriceEventAt !== null && eventAt < this.lastPriceEventAt)
      return;
    this.lastPrice = price;
    this.lastPriceEventAt = eventAt;
    this.lastPriceReceivedAt = receivedAt;
  }

  private returnBps(
    currentPrice: number,
    now: number,
    duration: number,
  ): number | null {
    const target = now - duration;
    const candidates = [...this.tradeBuckets.values()].filter(
      (bucket) =>
        Math.abs(bucket.second - target) <= RETURN_REFERENCE_MAX_GAP_MS,
    );
    candidates.sort(
      (a, b) => Math.abs(a.second - target) - Math.abs(b.second - target),
    );
    const reference = candidates[0];
    return reference ? bpsChange(currentPrice, reference.lastPrice) : null;
  }

  private tradeFlow(now: number, duration: number) {
    const cutoff = now - duration;
    let buyNotional = 0;
    let sellNotional = 0;
    let sampleCount = 0;
    for (const bucket of this.tradeBuckets.values()) {
      if (bucket.lastEventAt < cutoff || bucket.lastEventAt > now) continue;
      buyNotional += bucket.buyNotional;
      sellNotional += bucket.sellNotional;
      sampleCount += bucket.count;
    }
    const totalNotional = buyNotional + sellNotional;
    const signedDeltaNotional = buyNotional - sellNotional;
    return {
      sampleCount,
      buyNotional,
      sellNotional,
      totalNotional,
      signedDeltaNotional,
      normalizedDelta:
        totalNotional > 0 ? signedDeltaNotional / totalNotional : null,
      buyRatio: totalNotional > 0 ? buyNotional / totalNotional : null,
      tradesPerSecond: sampleCount / (duration / 1_000),
    };
  }

  private openInterestChange(now: number, duration: number): number | null {
    const current = this.openInterestHistory.at(-1);
    if (!current) return null;
    const target = now - duration;
    const reference = [...this.openInterestHistory]
      .filter((point) => Math.abs(point.at - target) <= OI_REFERENCE_MAX_GAP_MS)
      .sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target))[0];
    return reference
      ? percentChange(current.openInterest, reference.openInterest)
      : null;
  }

  private liquidationWindow(now: number, duration: number) {
    const cutoff = now - duration;
    let observedLongNotional = 0;
    let observedShortNotional = 0;
    let eventCount = 0;
    for (const event of this.liquidationEvents) {
      if (event.at < cutoff || event.at > now) continue;
      observedLongNotional += event.longNotional;
      observedShortNotional += event.shortNotional;
      eventCount += 1;
    }
    return {
      observedLongNotional,
      observedShortNotional,
      eventCount,
      coverage: 'SNAPSHOT' as const,
    };
  }

  private buildProvenance(now: number) {
    const rows = [];
    const add = (input: {
      source: string;
      eventAt: number | null;
      receivedAt: number | null;
      status: EvidenceStatus;
      coverage: EvidenceCoverage;
    }) => {
      if (input.receivedAt === null) return;
      rows.push(
        buildDataProvenance({
          source: input.source,
          venue: 'BINANCE_USDM',
          instrument: this.symbol,
          sourceEventAt: input.eventAt,
          collectorReceivedAt: input.receivedAt,
          generatedAt: now,
          now,
          metricNature: 'OBSERVED',
          coverage: input.coverage,
          status: input.status,
        }),
      );
    };

    const tradeAge =
      this.lastPriceReceivedAt === null
        ? null
        : Math.max(0, now - this.lastPriceReceivedAt);
    add({
      source: 'BINANCE_USDM_AGG_TRADE',
      eventAt: this.lastPriceEventAt,
      receivedAt: this.lastPriceReceivedAt,
      status: sourceStatus(
        tradeAge,
        MULTICOIN_FRESHNESS_THRESHOLDS.leadTradeBook,
      ),
      coverage: 'SAMPLED',
    });

    const bookAge =
      this.book.receivedAt === null
        ? null
        : Math.max(0, now - this.book.receivedAt);
    add({
      source: 'BINANCE_USDM_BOOK_TICKER',
      eventAt: this.book.eventAt,
      receivedAt: this.book.receivedAt,
      status: sourceStatus(
        bookAge,
        MULTICOIN_FRESHNESS_THRESHOLDS.leadTradeBook,
      ),
      coverage: 'SNAPSHOT',
    });

    const depthAge =
      this.depth.receivedAt === null
        ? null
        : Math.max(0, now - this.depth.receivedAt);
    add({
      source: 'BINANCE_USDM_PARTIAL_DEPTH20',
      eventAt: this.depth.eventAt,
      receivedAt: this.depth.receivedAt,
      status: sourceStatus(
        depthAge,
        MULTICOIN_FRESHNESS_THRESHOLDS.leadTradeBook,
      ),
      coverage: 'SNAPSHOT',
    });

    const markAge =
      this.mark.receivedAt === null
        ? null
        : Math.max(0, now - this.mark.receivedAt);
    add({
      source: 'BINANCE_USDM_MARK_PRICE',
      eventAt: this.mark.eventAt,
      receivedAt: this.mark.receivedAt,
      status: sourceStatus(
        markAge,
        MULTICOIN_FRESHNESS_THRESHOLDS.leadTradeBook,
      ),
      coverage: 'SNAPSHOT',
    });

    const oi = this.openInterestHistory.at(-1) ?? null;
    const oiAge = oi ? Math.max(0, now - oi.receivedAt) : null;
    add({
      source: 'BINANCE_USDM_OPEN_INTEREST',
      eventAt: oi?.at ?? null,
      receivedAt: oi?.receivedAt ?? null,
      status: sourceStatus(
        oiAge,
        MULTICOIN_FRESHNESS_THRESHOLDS.leadOpenInterest,
      ),
      coverage: 'SNAPSHOT',
    });

    const liquidation = this.liquidationEvents.at(-1) ?? null;
    const liquidationAge = liquidation
      ? Math.max(0, now - liquidation.receivedAt)
      : null;
    add({
      source: 'BINANCE_USDM_FORCE_ORDER',
      eventAt: liquidation?.at ?? null,
      receivedAt: liquidation?.receivedAt ?? null,
      status: sourceStatus(
        liquidationAge,
        MULTICOIN_FRESHNESS_THRESHOLDS.leadTradeBook,
      ),
      coverage: 'SNAPSHOT',
    });

    if (rows.length === 0) {
      rows.push(
        buildDataProvenance({
          source: 'LOCAL_LEAD_CORE',
          venue: 'BINANCE_USDM',
          instrument: this.symbol,
          sourceEventAt: null,
          collectorReceivedAt: now,
          generatedAt: now,
          now,
          metricNature: 'DERIVED',
          coverage: 'UNKNOWN',
          status: 'UNAVAILABLE',
        }),
      );
    }
    return rows;
  }

  private prune(now: number): void {
    const tradeCutoff = now - MAX_TRADE_HISTORY_MS;
    for (const [second] of this.tradeBuckets) {
      if (second < tradeCutoff) this.tradeBuckets.delete(second);
    }
    const oiCutoff = now - MAX_OI_HISTORY_MS;
    while (
      this.openInterestHistory.length > 0 &&
      (this.openInterestHistory[0]?.at ?? now) < oiCutoff
    )
      this.openInterestHistory.shift();
    const liquidationCutoff = now - MAX_LIQUIDATION_HISTORY_MS;
    while (
      this.liquidationEvents.length > 0 &&
      (this.liquidationEvents[0]?.at ?? now) < liquidationCutoff
    )
      this.liquidationEvents.shift();
  }
}

export function relativeReturnBps(
  leadReturnBps: number | null,
  btcReturnBps: number | null,
): number | null {
  if (leadReturnBps === null || btcReturnBps === null) return null;
  if (!Number.isFinite(leadReturnBps) || !Number.isFinite(btcReturnBps))
    return null;
  return leadReturnBps - btcReturnBps;
}
