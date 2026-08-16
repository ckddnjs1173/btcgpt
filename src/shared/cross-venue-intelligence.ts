import { z } from 'zod';

import { dataProvenanceSchema } from './market-intelligence';

export const COINBASE_SPOT_PRODUCTS = [
  'BTC-USD',
  'ETH-USD',
  'SOL-USD',
] as const;
export type CoinbaseSpotProduct = (typeof COINBASE_SPOT_PRODUCTS)[number];
export type CrossVenueAsset = 'BTC' | 'ETH' | 'SOL';

const finite = z.number().finite();
const nullableFinite = finite.nullable();
const epochMs = z.number().int().nonnegative();

const returnsSchema = z
  .object({
    '15s': nullableFinite,
    '30s': nullableFinite,
    '1m': nullableFinite,
    '3m': nullableFinite,
    '5m': nullableFinite,
    '15m': nullableFinite,
  })
  .strict();

const flowWindowSchema = z
  .object({
    tradeCount: z.number().int().nonnegative(),
    aggressiveBuyNotional: z.number().nonnegative(),
    aggressiveSellNotional: z.number().nonnegative(),
    normalizedTakerDelta: z.number().min(-1).max(1).nullable(),
    aggressiveBuyRatio: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const coinbaseSpotObservationSchema = z
  .object({
    productId: z.enum(COINBASE_SPOT_PRODUCTS),
    asset: z.enum(['BTC', 'ETH', 'SOL']),
    venue: z.literal('COINBASE_SPOT'),
    quoteAsset: z.literal('USD'),
    generatedAt: epochMs,
    lastPrice: z.number().positive().nullable(),
    bidPrice: z.number().positive().nullable(),
    askPrice: z.number().positive().nullable(),
    spreadBps: nullableFinite,
    returnsBps: returnsSchema,
    flow: z
      .object({
        '15s': flowWindowSchema,
        '30s': flowWindowSchema,
        '1m': flowWindowSchema,
        '3m': flowWindowSchema,
        '5m': flowWindowSchema,
      })
      .strict(),
    microstructure: z
      .object({
        bookSynchronized: z.boolean(),
        bidNotional20: z.number().nonnegative(),
        askNotional20: z.number().nonnegative(),
        depthImbalance20: z.number().min(-1).max(1).nullable(),
        microPrice: z.number().positive().nullable(),
        level2ObservedAt: epochMs.nullable(),
      })
      .strict(),
    connection: z
      .object({
        connected: z.boolean(),
        lastMessageAt: epochMs.nullable(),
        lastHeartbeatAt: epochMs.nullable(),
        reconnectCount: z.number().int().nonnegative(),
        sequenceGapCount: z.number().int().nonnegative(),
      })
      .strict(),
    provenance: z.array(dataProvenanceSchema).max(8),
  })
  .strict();
export type CoinbaseSpotObservation = z.infer<
  typeof coinbaseSpotObservationSchema
>;

const compactReturnsSchema = z
  .object({
    '1m': nullableFinite,
    '3m': nullableFinite,
    '5m': nullableFinite,
  })
  .strict();

const crossVenueAssetSchema = z
  .object({
    asset: z.enum(['BTC', 'ETH', 'SOL']),
    generatedAt: epochMs,
    coinbaseProductId: z.enum(COINBASE_SPOT_PRODUCTS),
    binanceInstrument: z.enum(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']),
    quoteCurrencyMismatch: z.literal(true),
    coinbaseSpot: z
      .object({
        lastPrice: z.number().positive().nullable(),
        bidPrice: z.number().positive().nullable(),
        askPrice: z.number().positive().nullable(),
        spreadBps: nullableFinite,
        returnsBps: compactReturnsSchema,
        normalizedTakerDelta1m: z.number().min(-1).max(1).nullable(),
        normalizedTakerDelta5m: z.number().min(-1).max(1).nullable(),
        depthImbalance20: z.number().min(-1).max(1).nullable(),
        microPrice: z.number().positive().nullable(),
      })
      .strict(),
    binancePerp: z
      .object({
        markPrice: z.number().positive().nullable(),
        returnsBps: compactReturnsSchema,
        normalizedTakerDelta1m: z.number().min(-1).max(1).nullable(),
        normalizedTakerDelta5m: z.number().min(-1).max(1).nullable(),
      })
      .strict(),
    derived: z
      .object({
        perpSpotReferenceSpreadBps: nullableFinite,
        returnDifferenceBps: compactReturnsSchema,
        normalizedTakerDeltaDifference1m: nullableFinite,
        normalizedTakerDeltaDifference5m: nullableFinite,
      })
      .strict(),
  })
  .strict();

export const crossVenueIntelligenceSchema = z
  .object({
    version: z.literal('cross-venue-v1'),
    generatedAt: epochMs,
    objectiveOnly: z.literal(true),
    interpretationBoundary: z.literal(
      'BINANCE_USDT_PERP_VS_COINBASE_USD_SPOT_REFERENCE_ONLY',
    ),
    assets: z
      .object({
        BTC: crossVenueAssetSchema.nullable(),
        ETH: crossVenueAssetSchema.nullable(),
        SOL: crossVenueAssetSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type CrossVenueIntelligence = z.infer<
  typeof crossVenueIntelligenceSchema
>;
