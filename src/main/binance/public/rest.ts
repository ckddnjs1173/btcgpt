import { depthEntrySchema, klineTuple, klinesSchema, markPriceSchema, openInterestSchema, premiumIndexSchema, serverTimeSchema, ticker24hSchema } from '../schemas';
import type { KlineTuple } from '../schemas';

const BASE = 'https://fapi.binance.com';

function parseJson<T>(res: Response, schema: { parse(input: unknown): T }): T {
  const json = (await res.json()) as unknown;
  return schema.parse(json);
}

export async function fetchServerTime(): Promise<{ serverTime: number }> {
  const res = await fetch(`${BASE}/fapi/v1/time`);
  return parseJson(res, serverTimeSchema);
}

export async function fetchKlines(
  symbol = 'BTCUSDT',
  interval = '5m',
  limit = 500,
): Promise<KlineTuple[]> {
  const url = new URL(`${BASE}/fapi/v1/klines`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url.toString());
  return parseJson(res, klinesSchema);
}

export async function fetchMarkPrice(symbol = 'BTCUSDT') {
  const url = `${BASE}/fapi/v1/premiumIndex?symbol=${symbol}`;
  return parseJson(await fetch(url), markPriceSchema);
}

export async function fetchTicker24h(symbol = 'BTCUSDT') {
  const url = `${BASE}/fapi/v1/ticker/24hr?symbol=${symbol}`;
  return parseJson(await fetch(url), ticker24hSchema);
}

export async function fetchOrderBook(symbol = 'BTCUSDT', limit = 20) {
  const url = new URL(`${BASE}/fapi/v1/depth`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url.toString());
  const json = (await res.json()) as unknown;
  return z.object({
    lastUpdateId: z.number(),
    E: z.number(),
    T: z.number(),
    symbol: z.string(),
    bids: z.array(depthEntrySchema),
    asks: z.array(depthEntrySchema),
  }).parse(json);
}

export async function fetchPremiumIndex(symbol = 'BTCUSDT') {
  const url = `${BASE}/fapi/v1/premiumIndex?symbol=${symbol}`;
  return parseJson(await fetch(url), premiumIndexSchema);
}

export async function fetchOpenInterest(symbol = 'BTCUSDT') {
  const url = `${BASE}/fapi/v1/openInterest?symbol=${symbol}`;
  return parseJson(await fetch(url), openInterestSchema);
}
