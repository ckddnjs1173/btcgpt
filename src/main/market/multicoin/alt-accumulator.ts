import {
  altAssetObservationSchema,
  type AltAssetObservation,
} from '../../../shared/alt-market-intelligence';
import type {
  CryptoAssetTier,
  EvidenceCoverage,
  EvidenceStatus,
} from '../../../shared/market-intelligence';
import {
  classifyEvidenceAge,
  MULTICOIN_FRESHNESS_THRESHOLDS,
} from '../intelligence/freshness';
import { buildDataProvenance } from '../intelligence/provenance';

const RETURN_WINDOWS_MS = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
} as const;
const OI_WINDOWS_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
} as const;
const MAX_TRADE_HISTORY_MS = 65 * 60_000;
const MAX_OI_HISTORY_MS = 16 * 60_000;
const MAX_LIQUIDATION_HISTORY_MS = 16 * 60_000;
const RETURN_REFERENCE_MAX_GAP_MS = 5_000;
const OI_REFERENCE_MAX_GAP_MS = 30_000;

type AltTier = Extract<CryptoAssetTier, 'SENTIMENT_CORE' | 'DYNAMIC'>;

type TradeBucket = {
  second: number;
  lastPrice: number;
  buyNotional: number;
  sellNotional: number;
  count: number;
  eventAt: number;
  receivedAt: number;
};

type OiPoint = {
  at: number;
  receivedAt: number;
  value: number;
};

type LiquidationEvent = {
  at: number;
  receivedAt: number;
  longNotional: number;
  shortNotional: number;
};

type BookState = {
  bidPrice: number | null;
  askPrice: number | null;
  eventAt: number | null;
  receivedAt: number | null;
};

type MarkState = {
  markPrice: number | null;
  fundingRate: number | null;
  eventAt: number | null;
  receivedAt: number | null;
};

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function nonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function bpsChange(current: number, previous: number): number | null {
  if (!positive(current) || !positive(previous)) return null;
  return ((current - previous) / previous) * 10_000;
}

function percentChange(current: number, previous: number): number | null {
  if (!nonNegative(current) || !positive(previous)) return null;
  return ((current - previous) / previous) * 100;
}

export class AltAssetAccumulator {
  private readonly tradeBuckets = new Map<number, TradeBucket>();
  private readonly openInterestHistory: OiPoint[] = [];
  private readonly liquidations: LiquidationEvent[] = [];
  private lastPrice: number | null = null;
  private lastPriceEventAt: number | null = null;
  private lastPriceReceivedAt: number | null = null;
  private readonly book: BookState = {
    bidPrice: null,
    askPrice: null,
    eventAt: null,
    receivedAt: null,
  };
  private readonly mark: MarkState = {
    markPrice: null,
    fundingRate: null,
    eventAt: null,
    receivedAt: null,
  };

  constructor(
    readonly symbol: string,
    readonly baseAsset: string,
    private tier: AltTier,
  ) {}

  setTier(tier: AltTier): void {
    this.tier = tier;
  }

  resetPublicStream(): void {
    this.book.bidPrice = null;
    this.book.askPrice = null;
    this.book.eventAt = null;
    this.book.receivedAt = null;
  }

  resetMarketStream(): void {
    this.tradeBuckets.clear();
    this.liquidations.length = 0;
    this.lastPrice = null;
    this.lastPriceEventAt = null;
    this.lastPriceReceivedAt = null;
    this.mark.markPrice = null;
    this.mark.fundingRate = null;
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
    if (!positive(input.price) || !positive(input.quantity)) return;
    const second = Math.floor(input.eventAt / 1_000) * 1_000;
    const notional = input.price * input.quantity;
    const current = this.tradeBuckets.get(second);
    const buyNotional = input.buyerIsMaker ? 0 : notional;
    const sellNotional = input.buyerIsMaker ? notional : 0;
    if (current) {
      current.lastPrice = input.price;
      current.buyNotional += buyNotional;
      current.sellNotional += sellNotional;
      current.count += 1;
      current.eventAt = Math.max(current.eventAt, input.eventAt);
      current.receivedAt = Math.max(current.receivedAt, input.receivedAt);
    } else {
      this.tradeBuckets.set(second, {
        second,
        lastPrice: input.price,
        buyNotional,
        sellNotional,
        count: 1,
        eventAt: input.eventAt,
        receivedAt: input.receivedAt,
      });
    }
    if (
      this.lastPriceEventAt === null ||
      input.eventAt >= this.lastPriceEventAt
    ) {
      this.lastPrice = input.price;
      this.lastPriceEventAt = input.eventAt;
      this.lastPriceReceivedAt = input.receivedAt;
    }
    this.prune(input.receivedAt);
  }

  recordBook(input: {
    bidPrice: number;
    askPrice: number;
    eventAt: number;
    receivedAt: number;
  }): void {
    if (!positive(input.bidPrice) || !positive(input.askPrice)) return;
    this.book.bidPrice = input.bidPrice;
    this.book.askPrice = input.askPrice;
    this.book.eventAt = input.eventAt;
    this.book.receivedAt = input.receivedAt;
  }

  recordMark(input: {
    markPrice: number;
    fundingRate: number;
    eventAt: number;
    receivedAt: number;
  }): void {
    if (!positive(input.markPrice)) return;
    this.mark.markPrice = input.markPrice;
    this.mark.fundingRate = Number.isFinite(input.fundingRate)
      ? input.fundingRate
      : null;
    this.mark.eventAt = input.eventAt;
    this.mark.receivedAt = input.receivedAt;
  }

  recordOpenInterest(input: {
    value: number;
    observedAt: number;
    receivedAt: number;
  }): void {
    if (!nonNegative(input.value)) return;
    const previous = this.openInterestHistory.at(-1);
    if (previous && input.observedAt < previous.at) return;
    if (previous && input.observedAt === previous.at) {
      this.openInterestHistory[this.openInterestHistory.length - 1] = {
        at: input.observedAt,
        receivedAt: input.receivedAt,
        value: input.value,
      };
    } else {
      this.openInterestHistory.push({
        at: input.observedAt,
        receivedAt: input.receivedAt,
        value: input.value,
      });
    }
    this.prune(input.receivedAt);
  }

  recordLiquidation(input: {
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    eventAt: number;
    receivedAt: number;
  }): void {
    if (!positive(input.price) || !positive(input.quantity)) return;
    const notional = input.price * input.quantity;
    this.liquidations.push({
      at: input.eventAt,
      receivedAt: input.receivedAt,
      longNotional: input.side === 'SELL' ? notional : 0,
      shortNotional: input.side === 'BUY' ? notional : 0,
    });
    this.prune(input.receivedAt);
  }

  snapshot(now = Date.now()): AltAssetObservation | null {
    this.prune(now);
    if (
      this.lastPrice === null &&
      this.book.bidPrice === null &&
      this.mark.markPrice === null
    )
      return null;

    const latestOi = this.openInterestHistory.at(-1) ?? null;
    const currentPrice = this.lastPrice ?? this.mark.markPrice;
    const sourceEventAt = Math.max(
      this.lastPriceEventAt ?? 0,
      this.book.eventAt ?? 0,
      this.mark.eventAt ?? 0,
      latestOi?.at ?? 0,
      this.liquidations.at(-1)?.at ?? 0,
    );
    const collectorReceivedAt = Math.max(
      this.lastPriceReceivedAt ?? 0,
      this.book.receivedAt ?? 0,
      this.mark.receivedAt ?? 0,
      latestOi?.receivedAt ?? 0,
      this.liquidations.at(-1)?.receivedAt ?? 0,
    );
    const currentMinute = this.flowWindow(now, 60_000);
    const previousMinute = this.flowRange(now - 120_000, now - 60_000);

    return altAssetObservationSchema.parse({
      symbol: this.symbol,
      baseAsset: this.baseAsset,
      quoteAsset: 'USDT',
      venue: 'BINANCE_USDM',
      instrumentType: 'PERPETUAL',
      tier: this.tier,
      generatedAt: now,
      sourceEventAt: sourceEventAt > 0 ? sourceEventAt : null,
      collectorReceivedAt: collectorReceivedAt > 0 ? collectorReceivedAt : now,
      provenance: this.provenance(now),
      market: {
        lastPrice: this.lastPrice,
        markPrice: this.mark.markPrice,
        bidPrice: this.book.bidPrice,
        askPrice: this.book.askPrice,
        spreadBps:
          this.book.bidPrice !== null && this.book.askPrice !== null
            ? ((this.book.askPrice - this.book.bidPrice) /
                ((this.book.askPrice + this.book.bidPrice) / 2)) *
              10_000
            : null,
        fundingRate: this.mark.fundingRate,
      },
      returnsBps: Object.fromEntries(
        Object.entries(RETURN_WINDOWS_MS).map(([window, duration]) => [
          window,
          currentPrice === null
            ? null
            : this.returnBps(currentPrice, now, duration),
        ]),
      ),
      flow: {
        '1m': currentMinute,
        '5m': this.flowWindow(now, 5 * 60_000),
        '15m': this.flowWindow(now, 15 * 60_000),
        volumeAcceleration1m:
          previousMinute.totalNotional > 0
            ? currentMinute.totalNotional / previousMinute.totalNotional - 1
            : null,
      },
      openInterest: {
        current: latestOi?.value ?? null,
        notional:
          latestOi && currentPrice !== null
            ? latestOi.value * currentPrice
            : null,
        observedAt: latestOi?.at ?? null,
        changesPercent: Object.fromEntries(
          Object.entries(OI_WINDOWS_MS).map(([window, duration]) => [
            window,
            this.oiChange(now, duration),
          ]),
        ),
      },
      liquidations: {
        '5m': this.liquidationWindow(now, 5 * 60_000),
        '15m': this.liquidationWindow(now, 15 * 60_000),
      },
    });
  }

  private returnBps(
    currentPrice: number,
    now: number,
    duration: number,
  ): number | null {
    const target = now - duration;
    const reference = [...this.tradeBuckets.values()]
      .filter(
        (bucket) =>
          Math.abs(bucket.second - target) <= RETURN_REFERENCE_MAX_GAP_MS,
      )
      .sort(
        (a, b) => Math.abs(a.second - target) - Math.abs(b.second - target),
      )[0];
    return reference ? bpsChange(currentPrice, reference.lastPrice) : null;
  }

  private flowWindow(now: number, duration: number) {
    return this.flowRange(now - duration, now);
  }

  private flowRange(start: number, end: number) {
    let buyNotional = 0;
    let sellNotional = 0;
    let sampleCount = 0;
    for (const bucket of this.tradeBuckets.values()) {
      if (bucket.eventAt < start || bucket.eventAt > end) continue;
      buyNotional += bucket.buyNotional;
      sellNotional += bucket.sellNotional;
      sampleCount += bucket.count;
    }
    const totalNotional = buyNotional + sellNotional;
    const signedDeltaNotional = buyNotional - sellNotional;
    return {
      sampleCount,
      totalNotional,
      signedDeltaNotional,
      normalizedDelta:
        totalNotional > 0 ? signedDeltaNotional / totalNotional : null,
      buyRatio: totalNotional > 0 ? buyNotional / totalNotional : null,
    };
  }

  private oiChange(now: number, duration: number): number | null {
    const current = this.openInterestHistory.at(-1);
    if (!current) return null;
    const target = now - duration;
    const reference = [...this.openInterestHistory]
      .filter((point) => Math.abs(point.at - target) <= OI_REFERENCE_MAX_GAP_MS)
      .sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target))[0];
    return reference ? percentChange(current.value, reference.value) : null;
  }

  private liquidationWindow(now: number, duration: number) {
    let observedLongNotional = 0;
    let observedShortNotional = 0;
    let eventCount = 0;
    for (const event of this.liquidations) {
      if (event.at < now - duration || event.at > now) continue;
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

  private provenance(now: number) {
    const rows = [];
    const add = (input: {
      source: string;
      eventAt: number | null;
      receivedAt: number | null;
      coverage: EvidenceCoverage;
      threshold: (typeof MULTICOIN_FRESHNESS_THRESHOLDS)[keyof typeof MULTICOIN_FRESHNESS_THRESHOLDS];
    }) => {
      if (input.receivedAt === null) return;
      const age = Math.max(0, now - input.receivedAt);
      const status: EvidenceStatus = classifyEvidenceAge(age, input.threshold);
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
          status,
        }),
      );
    };
    add({
      source: 'BINANCE_USDM_ALT_AGG_TRADE',
      eventAt: this.lastPriceEventAt,
      receivedAt: this.lastPriceReceivedAt,
      coverage: 'SAMPLED',
      threshold: MULTICOIN_FRESHNESS_THRESHOLDS.dynamicPrice,
    });
    add({
      source: 'BINANCE_USDM_ALT_BOOK_TICKER',
      eventAt: this.book.eventAt,
      receivedAt: this.book.receivedAt,
      coverage: 'SNAPSHOT',
      threshold: MULTICOIN_FRESHNESS_THRESHOLDS.dynamicPrice,
    });
    add({
      source: 'BINANCE_USDM_ALT_MARK_PRICE',
      eventAt: this.mark.eventAt,
      receivedAt: this.mark.receivedAt,
      coverage: 'SNAPSHOT',
      threshold: MULTICOIN_FRESHNESS_THRESHOLDS.dynamicPrice,
    });
    const oi = this.openInterestHistory.at(-1) ?? null;
    add({
      source: 'BINANCE_USDM_ALT_OPEN_INTEREST',
      eventAt: oi?.at ?? null,
      receivedAt: oi?.receivedAt ?? null,
      coverage: 'SNAPSHOT',
      threshold: MULTICOIN_FRESHNESS_THRESHOLDS.dynamicOpenInterest,
    });
    const liquidation = this.liquidations.at(-1) ?? null;
    add({
      source: 'BINANCE_USDM_ALT_FORCE_ORDER',
      eventAt: liquidation?.at ?? null,
      receivedAt: liquidation?.receivedAt ?? null,
      coverage: 'SNAPSHOT',
      threshold: MULTICOIN_FRESHNESS_THRESHOLDS.dynamicPrice,
    });
    if (rows.length === 0) {
      rows.push(
        buildDataProvenance({
          source: 'LOCAL_ALT_MARKET',
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
    while ((this.openInterestHistory[0]?.at ?? now) < oiCutoff)
      this.openInterestHistory.shift();
    const liquidationCutoff = now - MAX_LIQUIDATION_HISTORY_MS;
    while ((this.liquidations[0]?.at ?? now) < liquidationCutoff)
      this.liquidations.shift();
  }
}
