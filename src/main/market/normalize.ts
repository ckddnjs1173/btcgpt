import type { KlineTuple } from '../binance/schemas';
import { SYMBOL, type Candle, type Timeframe } from './types';

function finite(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Binance numeric field: ${field}`);
  }
  return parsed;
}

export function normalizeRestCandle(
  timeframe: Timeframe,
  tuple: KlineTuple,
  now = Date.now(),
): Candle {
  return {
    symbol: SYMBOL,
    timeframe,
    openTime: tuple[0],
    open: finite(tuple[1], 'open'),
    high: finite(tuple[2], 'high'),
    low: finite(tuple[3], 'low'),
    close: finite(tuple[4], 'close'),
    volume: finite(tuple[5], 'volume'),
    closeTime: tuple[6],
    quoteVolume: finite(tuple[7], 'quoteVolume'),
    tradeCount: tuple[8],
    takerBuyBaseVolume: finite(tuple[9], 'takerBuyBaseVolume'),
    takerBuyQuoteVolume: finite(tuple[10], 'takerBuyQuoteVolume'),
    isClosed: tuple[6] < now,
    eventTime: now,
    receivedAt: now,
  };
}
