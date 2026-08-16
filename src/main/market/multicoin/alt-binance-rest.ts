import { z } from 'zod';

import { numericStringSchema } from '../../binance/schemas';
import {
  SENTIMENT_CORE_SYMBOLS,
  dynamicBasketCandidateSchema,
  type DynamicBasketCandidate,
} from '../../../shared/alt-market-intelligence';

const BASE = 'https://fapi.binance.com';
const MIN_LISTING_AGE_MS = 24 * 60 * 60_000;
const OI_CONCURRENCY = 8;

const STABLE_BASE_ASSETS = new Set([
  'BUSD',
  'DAI',
  'FDUSD',
  'PYUSD',
  'TUSD',
  'USDC',
  'USDD',
  'USDE',
  'USDP',
  'USD1',
  'USTC',
]);
const EXCLUDED_SYMBOLS = new Set<string>([
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  ...SENTIMENT_CORE_SYMBOLS,
]);

const exchangeSymbolSchema = z.object({
  symbol: z.string(),
  pair: z.string().optional(),
  contractType: z.string(),
  status: z.string(),
  onboardDate: z.number().nullable().optional(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  underlyingType: z.string().optional(),
});
const exchangeInfoSchema = z.object({
  serverTime: z.number(),
  symbols: z.array(exchangeSymbolSchema),
});
const allTickerSchema = z.array(
  z.object({
    symbol: z.string(),
    lastPrice: numericStringSchema,
    quoteVolume: numericStringSchema,
    count: z.number().int().nonnegative(),
  }),
);
const allBookTickerSchema = z.array(
  z.object({
    symbol: z.string(),
    bidPrice: numericStringSchema,
    bidQty: numericStringSchema,
    askPrice: numericStringSchema,
    askQty: numericStringSchema,
    time: z.number(),
  }),
);
const genericOpenInterestSchema = z.object({
  symbol: z.string(),
  openInterest: numericStringSchema,
  time: z.number(),
});

export type AltExchangeInfo = z.infer<typeof exchangeInfoSchema>;
export type AltTicker24h = z.infer<typeof allTickerSchema>[number];
export type AltBookTicker = z.infer<typeof allBookTickerSchema>[number];
export type GenericOpenInterest = z.infer<typeof genericOpenInterestSchema>;

async function getJson<T>(
  path: string,
  schema: { parse(input: unknown): T },
  parameters: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(parameters))
    url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok)
    throw new Error(`Binance public API returned HTTP ${response.status}`);
  return schema.parse((await response.json()) as unknown);
}

export const fetchAltExchangeInfo = () =>
  getJson('/fapi/v1/exchangeInfo', exchangeInfoSchema);
export const fetchAllAltTickers = () =>
  getJson('/fapi/v1/ticker/24hr', allTickerSchema);
export const fetchAllAltBookTickers = () =>
  getJson('/fapi/v1/ticker/bookTicker', allBookTickerSchema);
export const fetchGenericOpenInterest = (symbol: string) =>
  getJson('/fapi/v1/openInterest', genericOpenInterestSchema, { symbol });

export function eligibleDynamicSymbols(
  exchangeInfo: AltExchangeInfo,
  now: number,
): Array<{ symbol: string; baseAsset: string; onboardDate: number | null }> {
  return exchangeInfo.symbols
    .filter((row) => row.contractType === 'PERPETUAL')
    .filter((row) => row.status === 'TRADING')
    .filter((row) => row.quoteAsset === 'USDT')
    .filter(
      (row) =>
        row.underlyingType === undefined || row.underlyingType === 'COIN',
    )
    .filter((row) => !STABLE_BASE_ASSETS.has(row.baseAsset))
    .filter((row) => !EXCLUDED_SYMBOLS.has(row.symbol))
    .filter((row) => {
      const onboardDate = row.onboardDate ?? null;
      return onboardDate === null || now - onboardDate >= MIN_LISTING_AGE_MS;
    })
    .map((row) => ({
      symbol: row.symbol,
      baseAsset: row.baseAsset,
      onboardDate: row.onboardDate ?? null,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function spreadBps(book: AltBookTicker | undefined): number | null {
  if (!book) return null;
  const bid = Number(book.bidPrice);
  const ask = Number(book.askPrice);
  const midpoint = (bid + ask) / 2;
  if (
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    midpoint <= 0 ||
    ask < bid
  )
    return null;
  return ((ask - bid) / midpoint) * 10_000;
}

async function mapInBatches<TInput, TOutput>(
  inputs: TInput[],
  batchSize: number,
  mapper: (input: TInput) => Promise<TOutput>,
): Promise<Array<PromiseSettledResult<TOutput>>> {
  const results: Array<PromiseSettledResult<TOutput>> = [];
  for (let index = 0; index < inputs.length; index += batchSize) {
    const batch = inputs.slice(index, index + batchSize);
    const settled = await Promise.allSettled(batch.map(mapper));
    results.push(...settled);
  }
  return results;
}

export async function scanDynamicBasketCandidates(
  now = Date.now(),
  dependencies: {
    fetchExchangeInfo?: typeof fetchAltExchangeInfo;
    fetchTickers?: typeof fetchAllAltTickers;
    fetchBookTickers?: typeof fetchAllAltBookTickers;
    fetchOpenInterest?: typeof fetchGenericOpenInterest;
  } = {},
): Promise<DynamicBasketCandidate[]> {
  const fetchExchangeInfo =
    dependencies.fetchExchangeInfo ?? fetchAltExchangeInfo;
  const fetchTickers = dependencies.fetchTickers ?? fetchAllAltTickers;
  const fetchBookTickers =
    dependencies.fetchBookTickers ?? fetchAllAltBookTickers;
  const fetchOpenInterest =
    dependencies.fetchOpenInterest ?? fetchGenericOpenInterest;

  const [exchangeInfo, tickers, books] = await Promise.all([
    fetchExchangeInfo(),
    fetchTickers(),
    fetchBookTickers(),
  ]);
  const eligible = eligibleDynamicSymbols(exchangeInfo, now);
  const tickerBySymbol = new Map(tickers.map((row) => [row.symbol, row]));
  const bookBySymbol = new Map(books.map((row) => [row.symbol, row]));
  const oiResults = await mapInBatches(
    eligible,
    OI_CONCURRENCY,
    async (row) => ({
      symbol: row.symbol,
      value: await fetchOpenInterest(row.symbol),
    }),
  );
  const oiBySymbol = new Map<string, GenericOpenInterest>();
  oiResults.forEach((result) => {
    if (result.status === 'fulfilled')
      oiBySymbol.set(result.value.symbol, result.value.value);
  });

  return eligible.map((row) => {
    const ticker = tickerBySymbol.get(row.symbol);
    const book = bookBySymbol.get(row.symbol);
    const oi = oiBySymbol.get(row.symbol);
    const lastPrice = ticker ? Number(ticker.lastPrice) : null;
    const openInterest = oi ? Number(oi.openInterest) : null;
    const openInterestNotional =
      lastPrice !== null &&
      Number.isFinite(lastPrice) &&
      lastPrice > 0 &&
      openInterest !== null &&
      Number.isFinite(openInterest) &&
      openInterest >= 0
        ? lastPrice * openInterest
        : null;
    return dynamicBasketCandidateSchema.parse({
      symbol: row.symbol,
      baseAsset: row.baseAsset,
      onboardDate: row.onboardDate,
      quoteVolume24h: ticker ? Math.max(0, Number(ticker.quoteVolume)) : 0,
      openInterestNotional,
      spreadBps: spreadBps(book),
      tradeCount24h: ticker?.count ?? 0,
      dataComplete:
        ticker !== undefined &&
        book !== undefined &&
        openInterestNotional !== null,
    });
  });
}
