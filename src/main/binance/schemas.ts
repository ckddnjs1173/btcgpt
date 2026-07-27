import { z } from 'zod';

export const serverTimeSchema = z.object({
  serverTime: z.number(),
});

export const klineTuple = z.tuple([
  z.number(), // open time
  z.string(), // open
  z.string(), // high
  z.string(), // low
  z.string(), // close
  z.string(), // volume
  z.number(), // close time
  z.string(), // quote asset volume
  z.number(), // trade count
  z.string(), // taker buy base volume
  z.string(), // taker buy quote volume
  z.string(), // ignore
]);

export const klinesSchema = z.array(klineTuple);

export const premiumIndexSchema = z.object({
  symbol: z.string(),
  markPrice: z.string(),
  indexPrice: z.string(),
  estimatedSettlePrice: z.string().optional(),
  lastFundingRate: z.string(),
  nextFundingTime: z.number(),
});

export const openInterestSchema = z.object({
  symbol: z.string(),
  openInterest: z.string(),
  time: z.number(),
});

export const ticker24hSchema = z.object({
  symbol: z.string(),
  priceChangePercent: z.string(),
  weightedAvgPrice: z.string(),
  prevClosePrice: z.string(),
  lastPrice: z.string(),
  lastQty: z.string(),
  bidPrice: z.string(),
  askPrice: z.string(),
  openPrice: z.string(),
  highPrice: z.string(),
  lowPrice: z.string(),
  volume: z.string(),
  quoteVolume: z.string(),
});

export const markPriceSchema = z.object({
  symbol: z.string(),
  markPrice: z.string(),
  indexPrice: z.string(),
  lastFundingRate: z.string(),
  nextFundingTime: z.number(),
});

export const depthEntrySchema = z.tuple([z.string(), z.string()]);
export const orderBookDepthSchema = z.object({
  lastUpdateId: z.number(),
  E: z.number(),
  T: z.number(),
  symbol: z.string(),
  bidDepth: z.array(depthEntrySchema),
  askDepth: z.array(depthEntrySchema),
});

export type KlineTuple = z.infer<typeof klineTuple>;
