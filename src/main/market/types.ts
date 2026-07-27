import type { DataStatus } from '../../shared/contracts';

export const SYMBOL = 'BTCUSDT' as const;
export const TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface Candle {
  symbol: typeof SYMBOL;
  timeframe: Timeframe;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  tradeCount: number;
  takerBuyBaseVolume: number;
  takerBuyQuoteVolume: number;
  isClosed: boolean;
  eventTime?: number;
  receivedAt: number;
}

export interface SourceHealth {
  status: DataStatus;
  lastEventAt: number | null;
  ageMs: number;
  reconnectCount: number;
  message: string | null;
  eventTime: number | null;
  receivedTime: number | null;
  lastSuccess: number | null;
  consecutiveFailures: number;
  validationError: string | null;
}

export interface PublicMarketState {
  lastPrice: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  openInterest: number | null;
  updatedAt: number | null;
  priceChangePercent24h: number | null;
  highPrice24h: number | null;
  lowPrice24h: number | null;
  volume24h: number | null;
  quoteVolume24h: number | null;
}

export interface ProductFilters {
  tickSize: number;
  stepSize: number;
  minQuantity: number;
  minNotional: number;
  updatedAt: number;
}

export interface DepthState {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  eventTime: number | null;
  receivedAt: number | null;
}

export interface TradeEvent {
  id?: number;
  eventTime: number;
  receivedAt: number;
  price: number;
  quantity: number;
  buyerIsMaker: boolean;
}

export interface LiquidationEvent {
  eventTime: number;
  receivedAt: number;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  notional: number;
}

export interface SentimentState {
  globalLongShortAccountRatio: number | null;
  topLongShortAccountRatio: number | null;
  topLongShortPositionRatio: number | null;
  takerBuySellRatio: number | null;
  openInterestChanges: Partial<Record<Timeframe, number | null>>;
  updatedAt: number | null;
}
