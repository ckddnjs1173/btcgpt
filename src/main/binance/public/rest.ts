import {
  aggregateTradesSchema,
  exchangeInfoSchema,
  klinesSchema,
  markPriceSchema,
  openInterestHistorySchema,
  openInterestSchema,
  orderBookDepthSchema,
  ratioHistorySchema,
  serverTimeSchema,
  ticker24hSchema,
} from '../schemas';
import type { KlineTuple } from '../schemas';
import type { Timeframe } from '../../market/types';

const BASE = 'https://fapi.binance.com';
const SYMBOL = 'BTCUSDT';

async function parseJson<T>(
  response: Response,
  schema: { parse(input: unknown): T },
): Promise<T> {
  if (!response.ok)
    throw new Error(`Binance public API returned HTTP ${response.status}`);
  return schema.parse((await response.json()) as unknown);
}

async function get<T>(
  path: string,
  schema: { parse(input: unknown): T },
  parameters: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(parameters))
    url.searchParams.set(key, value);
  return parseJson(
    await fetch(url, { signal: AbortSignal.timeout(8_000) }),
    schema,
  );
}

export const fetchServerTime = () => get('/fapi/v1/time', serverTimeSchema);
export const fetchExchangeInfo = () =>
  get('/fapi/v1/exchangeInfo', exchangeInfoSchema);

export function fetchKlines(
  symbol: typeof SYMBOL = SYMBOL,
  interval: Timeframe = '5m',
  limit = 500,
): Promise<KlineTuple[]> {
  return get('/fapi/v1/klines', klinesSchema, {
    symbol,
    interval,
    limit: String(Math.min(1500, Math.max(1, limit))),
  });
}

export const fetchMarkPrice = () =>
  get('/fapi/v1/premiumIndex', markPriceSchema, { symbol: SYMBOL });
export const fetchTicker24h = () =>
  get('/fapi/v1/ticker/24hr', ticker24hSchema, { symbol: SYMBOL });
export const fetchOpenInterest = () =>
  get('/fapi/v1/openInterest', openInterestSchema, { symbol: SYMBOL });
export const fetchOrderBook = (limit = 20) =>
  get('/fapi/v1/depth', orderBookDepthSchema, {
    symbol: SYMBOL,
    limit: String(limit),
  });
export const fetchAggregateTrades = (limit = 100) =>
  get('/fapi/v1/aggTrades', aggregateTradesSchema, {
    symbol: SYMBOL,
    limit: String(Math.min(1000, Math.max(1, limit))),
  });

export const fetchOpenInterestHistory = (period: Timeframe, limit = 30) =>
  get('/futures/data/openInterestHist', openInterestHistorySchema, {
    symbol: SYMBOL,
    period,
    limit: String(limit),
  });

type RatioPath =
  | '/futures/data/globalLongShortAccountRatio'
  | '/futures/data/topLongShortAccountRatio'
  | '/futures/data/topLongShortPositionRatio'
  | '/futures/data/takerlongshortRatio';

export const fetchRatioHistory = (
  path: RatioPath,
  period: Timeframe = '5m',
  limit = 2,
) =>
  get(path, ratioHistorySchema, {
    symbol: SYMBOL,
    period,
    limit: String(limit),
  });
