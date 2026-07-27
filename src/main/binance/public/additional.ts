import { z } from 'zod';

const BASE = 'https://fapi.binance.com';

export const premiumIndexSchema = z.object({
  symbol: z.string(),
  markPrice: z.string(),
  indexPrice: z.string(),
  estimatedSettlePrice: z.string().optional(),
  lastFundingRate: z.string(),
  nextFundingTime: z.number(),
});

export async function fetchPremiumIndex(symbol = 'BTCUSDT') : Promise<z.infer<typeof premiumIndexSchema>> {
  const url = `${BASE}/fapi/v1/premiumIndex?symbol=${symbol}`;
  const res = await fetch(url);
  const json = (await res.json()) as unknown;
  return premiumIndexSchema.parse(json);
}

export const openInterestSchema = z.object({
  symbol: z.string(),
  openInterest: z.string(),
  time: z.number(),
});

export async function fetchOpenInterest(symbol = 'BTCUSDT') : Promise<z.infer<typeof openInterestSchema>> {
  const url = `${BASE}/fapi/v1/openInterest?symbol=${symbol}`;
  const res = await fetch(url);
  const json = (await res.json()) as unknown;
  return openInterestSchema.parse(json);
}
