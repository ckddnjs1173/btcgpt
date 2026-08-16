import type {
  CoinbaseSpotObservation,
  CoinbaseSpotProduct,
  CrossVenueAsset,
} from '../../../shared/cross-venue-intelligence';
import { coinbaseSpotObservationSchema } from '../../../shared/cross-venue-intelligence';
import type { DataProvenance } from '../../../shared/market-intelligence';
import { buildDataProvenance } from '../intelligence/provenance';

const RETURN_WINDOWS = {
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
} as const;
const FLOW_WINDOWS = {
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
} as const;
const MAX_HISTORY_MS = 60 * 60_000;

export type CoinbaseBookSide = 'bid' | 'offer';

export interface CoinbaseTradeInput {
  eventTime: number;
  receivedAt: number;
  price: number;
  size: number;
  makerSide: 'BUY' | 'SELL';
}

interface PriceSample {
  at: number;
  price: number;
}

interface TradeSample extends CoinbaseTradeInput {
  notional: number;
  aggressiveSide: 'BUY' | 'SELL';
}

function assetFor(productId: CoinbaseSpotProduct): CrossVenueAsset {
  if (productId === 'BTC-USD') return 'BTC';
  if (productId === 'ETH-USD') return 'ETH';
  return 'SOL';
}

function bps(reference: number, value: number): number {
  return ((value - reference) / reference) * 10_000;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export class CoinbaseSpotAccumulator {
  private lastPrice: number | null = null;
  private bidPrice: number | null = null;
  private askPrice: number | null = null;
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private readonly prices: PriceSample[] = [];
  private readonly trades: TradeSample[] = [];
  private level2Synchronized = false;
  private level2ObservedAt: number | null = null;
  private lastTickerEventAt: number | null = null;
  private lastTickerReceivedAt: number | null = null;
  private lastTradeEventAt: number | null = null;
  private lastTradeReceivedAt: number | null = null;
  private lastLevel2EventAt: number | null = null;
  private lastLevel2ReceivedAt: number | null = null;

  constructor(readonly productId: CoinbaseSpotProduct) {}

  resetBook(): void {
    this.bids.clear();
    this.asks.clear();
    this.level2Synchronized = false;
    this.level2ObservedAt = null;
  }

  applyBookSnapshot(
    updates: Array<{ side: CoinbaseBookSide; price: number; quantity: number }>,
    eventTime: number,
    receivedAt: number,
  ): void {
    this.bids.clear();
    this.asks.clear();
    for (const update of updates) this.applyBookLevel(update);
    this.level2Synchronized = true;
    this.level2ObservedAt = receivedAt;
    this.lastLevel2EventAt = eventTime;
    this.lastLevel2ReceivedAt = receivedAt;
  }

  applyBookUpdate(
    updates: Array<{ side: CoinbaseBookSide; price: number; quantity: number }>,
    eventTime: number,
    receivedAt: number,
  ): void {
    if (!this.level2Synchronized) return;
    for (const update of updates) this.applyBookLevel(update);
    this.level2ObservedAt = receivedAt;
    this.lastLevel2EventAt = eventTime;
    this.lastLevel2ReceivedAt = receivedAt;
  }

  ingestTicker(input: {
    eventTime: number;
    receivedAt: number;
    price: number;
    bestBid: number | null;
    bestAsk: number | null;
  }): void {
    if (!finitePositive(input.price)) return;
    this.lastPrice = input.price;
    if (input.bestBid !== null && finitePositive(input.bestBid))
      this.bidPrice = input.bestBid;
    if (input.bestAsk !== null && finitePositive(input.bestAsk))
      this.askPrice = input.bestAsk;
    this.lastTickerEventAt = input.eventTime;
    this.lastTickerReceivedAt = input.receivedAt;
    this.addPrice(input.eventTime, input.price);
  }

  ingestTrade(input: CoinbaseTradeInput): void {
    if (!finitePositive(input.price) || !finitePositive(input.size)) return;
    // Coinbase Advanced Trade market_trades.side is the maker order side.
    // The aggressive taker side is therefore the opposite side.
    const aggressiveSide = input.makerSide === 'SELL' ? 'BUY' : 'SELL';
    this.trades.push({
      ...input,
      aggressiveSide,
      notional: input.price * input.size,
    });
    this.lastPrice = input.price;
    this.lastTradeEventAt = input.eventTime;
    this.lastTradeReceivedAt = input.receivedAt;
    this.addPrice(input.eventTime, input.price);
    this.trim(input.receivedAt);
  }

  snapshot(input: {
    now: number;
    connected: boolean;
    lastMessageAt: number | null;
    lastHeartbeatAt: number | null;
    reconnectCount: number;
    sequenceGapCount: number;
  }): CoinbaseSpotObservation | null {
    if (
      this.lastPrice === null &&
      this.bidPrice === null &&
      this.askPrice === null &&
      !this.level2Synchronized &&
      this.lastLevel2ReceivedAt === null
    )
      return null;
    this.trim(input.now);
    const topBids = [...this.bids.entries()]
      .filter(([, quantity]) => quantity > 0)
      .sort((left, right) => right[0] - left[0])
      .slice(0, 20);
    const topAsks = [...this.asks.entries()]
      .filter(([, quantity]) => quantity > 0)
      .sort((left, right) => left[0] - right[0])
      .slice(0, 20);
    const bestBid = this.level2Synchronized
      ? (topBids[0]?.[0] ?? null)
      : (this.bidPrice ?? null);
    const bestAsk = this.level2Synchronized
      ? (topAsks[0]?.[0] ?? null)
      : (this.askPrice ?? null);
    const spreadBps =
      bestBid !== null && bestAsk !== null && bestBid > 0
        ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000
        : null;
    const bidNotional20 = topBids.reduce(
      (sum, [price, quantity]) => sum + price * quantity,
      0,
    );
    const askNotional20 = topAsks.reduce(
      (sum, [price, quantity]) => sum + price * quantity,
      0,
    );
    const depthTotal = bidNotional20 + askNotional20;
    const depthImbalance20 =
      depthTotal > 0 ? (bidNotional20 - askNotional20) / depthTotal : null;
    const bestBidQuantity = topBids[0]?.[1] ?? null;
    const bestAskQuantity = topAsks[0]?.[1] ?? null;
    const microPrice =
      bestBid !== null &&
      bestAsk !== null &&
      bestBidQuantity !== null &&
      bestAskQuantity !== null &&
      bestBidQuantity + bestAskQuantity > 0
        ? (bestAsk * bestBidQuantity + bestBid * bestAskQuantity) /
          (bestBidQuantity + bestAskQuantity)
        : null;
    const provenance = this.provenance(input.now);
    const generatedAt = input.now;
    return coinbaseSpotObservationSchema.parse({
      productId: this.productId,
      asset: assetFor(this.productId),
      venue: 'COINBASE_SPOT',
      quoteAsset: 'USD',
      generatedAt,
      lastPrice: this.lastPrice,
      bidPrice: bestBid,
      askPrice: bestAsk,
      spreadBps,
      returnsBps: Object.fromEntries(
        Object.entries(RETURN_WINDOWS).map(([key, duration]) => [
          key,
          this.returnBps(duration, generatedAt),
        ]),
      ),
      flow: Object.fromEntries(
        Object.entries(FLOW_WINDOWS).map(([key, duration]) => [
          key,
          this.flow(duration, generatedAt),
        ]),
      ),
      microstructure: {
        bookSynchronized: this.level2Synchronized,
        bidNotional20,
        askNotional20,
        depthImbalance20,
        microPrice,
        level2ObservedAt: this.level2ObservedAt,
      },
      connection: {
        connected: input.connected,
        lastMessageAt: input.lastMessageAt,
        lastHeartbeatAt: input.lastHeartbeatAt,
        reconnectCount: input.reconnectCount,
        sequenceGapCount: input.sequenceGapCount,
      },
      provenance,
    });
  }

  private applyBookLevel(update: {
    side: CoinbaseBookSide;
    price: number;
    quantity: number;
  }): void {
    if (!finitePositive(update.price) || !Number.isFinite(update.quantity))
      return;
    const book = update.side === 'bid' ? this.bids : this.asks;
    if (update.quantity <= 0) book.delete(update.price);
    else book.set(update.price, update.quantity);
  }

  private addPrice(at: number, price: number): void {
    this.prices.push({ at, price });
    this.trim(at);
  }

  private trim(now: number): void {
    const cutoff = now - MAX_HISTORY_MS;
    while (this.prices.length > 0 && (this.prices[0]?.at ?? now) < cutoff)
      this.prices.shift();
    while (
      this.trades.length > 0 &&
      (this.trades[0]?.eventTime ?? now) < cutoff
    )
      this.trades.shift();
  }

  private returnBps(durationMs: number, now: number): number | null {
    if (this.lastPrice === null) return null;
    const cutoff = now - durationMs;
    let reference: PriceSample | null = null;
    for (const sample of this.prices) {
      if (sample.at <= cutoff) reference = sample;
      else break;
    }
    if (!reference) return null;
    return bps(reference.price, this.lastPrice);
  }

  private flow(durationMs: number, now: number) {
    const cutoff = now - durationMs;
    let buyNotional = 0;
    let sellNotional = 0;
    let tradeCount = 0;
    for (const trade of this.trades) {
      if (trade.eventTime < cutoff) continue;
      tradeCount += 1;
      if (trade.aggressiveSide === 'BUY') buyNotional += trade.notional;
      else sellNotional += trade.notional;
    }
    const total = buyNotional + sellNotional;
    return {
      tradeCount,
      aggressiveBuyNotional: buyNotional,
      aggressiveSellNotional: sellNotional,
      normalizedTakerDelta:
        total > 0 ? (buyNotional - sellNotional) / total : null,
      aggressiveBuyRatio: total > 0 ? buyNotional / total : null,
    };
  }

  private provenance(now: number): DataProvenance[] {
    const rows: DataProvenance[] = [];
    const add = (
      source: string,
      eventAt: number | null,
      receivedAt: number | null,
      coverage: 'EXHAUSTIVE' | 'SNAPSHOT',
    ) => {
      if (receivedAt === null) return;
      rows.push(
        buildDataProvenance({
          source,
          venue: 'COINBASE_SPOT',
          instrument: this.productId,
          sourceEventAt: eventAt,
          collectorReceivedAt: receivedAt,
          generatedAt: now,
          metricNature: 'OBSERVED',
          coverage,
          status: 'NORMAL',
          now,
        }),
      );
    };
    add(
      'COINBASE_ADVANCED_TICKER',
      this.lastTickerEventAt,
      this.lastTickerReceivedAt,
      'EXHAUSTIVE',
    );
    add(
      'COINBASE_ADVANCED_MARKET_TRADES',
      this.lastTradeEventAt,
      this.lastTradeReceivedAt,
      'EXHAUSTIVE',
    );
    add(
      'COINBASE_ADVANCED_LEVEL2',
      this.lastLevel2EventAt,
      this.lastLevel2ReceivedAt,
      'SNAPSHOT',
    );
    return rows;
  }
}
