import { z } from 'zod';

export const numericStringSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, 'Expected a decimal number string');

export const serverTimeSchema = z.object({
  serverTime: z.number(),
});

export const klineTuple = z.tuple([
  z.number(), // open time
  numericStringSchema, // open
  numericStringSchema, // high
  numericStringSchema, // low
  numericStringSchema, // close
  numericStringSchema, // volume
  z.number(), // close time
  numericStringSchema, // quote asset volume
  z.number(), // trade count
  numericStringSchema, // taker buy base volume
  numericStringSchema, // taker buy quote volume
  z.string(), // ignore
]);

export const klinesSchema = z.array(klineTuple);

export const premiumIndexSchema = z.object({
  symbol: z.literal('BTCUSDT'),
  markPrice: numericStringSchema,
  indexPrice: numericStringSchema,
  estimatedSettlePrice: numericStringSchema.optional(),
  lastFundingRate: numericStringSchema,
  nextFundingTime: z.number(),
});

export const openInterestSchema = z.object({
  symbol: z.literal('BTCUSDT'),
  openInterest: numericStringSchema,
  time: z.number(),
});

export const ticker24hSchema = z.object({
  symbol: z.literal('BTCUSDT'),
  priceChangePercent: numericStringSchema,
  weightedAvgPrice: numericStringSchema,
  prevClosePrice: numericStringSchema.optional(),
  lastPrice: numericStringSchema,
  lastQty: numericStringSchema,
  bidPrice: numericStringSchema.optional(),
  askPrice: numericStringSchema.optional(),
  openPrice: numericStringSchema,
  highPrice: numericStringSchema,
  lowPrice: numericStringSchema,
  volume: numericStringSchema,
  quoteVolume: numericStringSchema,
});

export const markPriceSchema = z.object({
  symbol: z.literal('BTCUSDT'),
  markPrice: numericStringSchema,
  indexPrice: numericStringSchema,
  lastFundingRate: numericStringSchema,
  nextFundingTime: z.number(),
});

export const depthEntrySchema = z.tuple([
  numericStringSchema,
  numericStringSchema,
]);
export const orderBookDepthSchema = z.object({
  lastUpdateId: z.number(),
  E: z.number().optional(),
  T: z.number().optional(),
  bids: z.array(depthEntrySchema).min(1),
  asks: z.array(depthEntrySchema).min(1),
});

const priceFilterSchema = z.object({
  filterType: z.literal('PRICE_FILTER'),
  tickSize: numericStringSchema,
});
const lotSizeFilterSchema = z.object({
  filterType: z.literal('LOT_SIZE'),
  minQty: numericStringSchema,
  stepSize: numericStringSchema,
});
const minNotionalFilterSchema = z.object({
  filterType: z.literal('MIN_NOTIONAL'),
  notional: numericStringSchema,
});
export const exchangeInfoSchema = z.object({
  serverTime: z.number(),
  symbols: z.array(
    z.object({
      symbol: z.string(),
      contractType: z.string(),
      status: z.string(),
      filters: z.array(
        z.union([
          priceFilterSchema,
          lotSizeFilterSchema,
          minNotionalFilterSchema,
          z.object({ filterType: z.string() }).passthrough(),
        ]),
      ),
    }),
  ),
});

export const ratioPointSchema = z
  .object({
    symbol: z.literal('BTCUSDT').optional(),
    longShortRatio: numericStringSchema.optional(),
    longAccount: numericStringSchema.optional(),
    shortAccount: numericStringSchema.optional(),
    buySellRatio: numericStringSchema.optional(),
    buyVol: numericStringSchema.optional(),
    sellVol: numericStringSchema.optional(),
    timestamp: z.number(),
  })
  .refine(
    (point) =>
      point.longShortRatio !== undefined || point.buySellRatio !== undefined,
    'Expected longShortRatio or buySellRatio',
  );
export const ratioHistorySchema = z.array(ratioPointSchema);

export const openInterestHistorySchema = z.array(
  z.object({
    symbol: z.literal('BTCUSDT'),
    sumOpenInterest: numericStringSchema,
    sumOpenInterestValue: numericStringSchema,
    timestamp: z.number(),
  }),
);

export const aggregateTradeSchema = z.object({
  a: z.number(),
  p: numericStringSchema,
  q: numericStringSchema,
  f: z.number(),
  l: z.number(),
  T: z.number(),
  m: z.boolean(),
});
export const aggregateTradesSchema = z.array(aggregateTradeSchema);

export type KlineTuple = z.infer<typeof klineTuple>;
