import { z } from 'zod';

import {
  cryptoAssetObservationBaseSchema,
  dataProvenanceSchema,
  evidenceHealthSchema,
} from './market-intelligence';

export const SENTIMENT_CORE_SYMBOLS = [
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'LINKUSDT',
  'SUIUSDT',
] as const;
export type SentimentCoreSymbol = (typeof SENTIMENT_CORE_SYMBOLS)[number];

export const ALT_MARKET_VERSION = 'alt-market-v1' as const;
export const DYNAMIC_BASKET_VERSION = 'dynamic-basket-v1' as const;

const epochMsSchema = z.number().int().nonnegative();
const finiteSchema = z.number().finite();
const nullableFiniteSchema = finiteSchema.nullable();
const symbolSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Z0-9-]+$/);

const altReturnsSchema = z
  .object({
    '1m': nullableFiniteSchema,
    '3m': nullableFiniteSchema,
    '5m': nullableFiniteSchema,
    '15m': nullableFiniteSchema,
    '1h': nullableFiniteSchema,
  })
  .strict();

const altFlowWindowSchema = z
  .object({
    sampleCount: z.number().int().nonnegative(),
    totalNotional: z.number().nonnegative(),
    signedDeltaNotional: finiteSchema,
    normalizedDelta: z.number().min(-1).max(1).nullable(),
    buyRatio: z.number().min(0).max(1).nullable(),
  })
  .strict();

const altOiChangesSchema = z
  .object({
    '1m': nullableFiniteSchema,
    '5m': nullableFiniteSchema,
    '15m': nullableFiniteSchema,
  })
  .strict();

const altLiquidationWindowSchema = z
  .object({
    observedLongNotional: z.number().nonnegative(),
    observedShortNotional: z.number().nonnegative(),
    eventCount: z.number().int().nonnegative(),
    coverage: z.literal('SNAPSHOT'),
  })
  .strict();

export const altAssetObservationSchema = cryptoAssetObservationBaseSchema
  .extend({
    quoteAsset: z.literal('USDT'),
    venue: z.literal('BINANCE_USDM'),
    instrumentType: z.literal('PERPETUAL'),
    tier: z.enum(['SENTIMENT_CORE', 'DYNAMIC']),
    market: z
      .object({
        lastPrice: z.number().positive().nullable(),
        markPrice: z.number().positive().nullable(),
        bidPrice: z.number().positive().nullable(),
        askPrice: z.number().positive().nullable(),
        spreadBps: nullableFiniteSchema,
        fundingRate: nullableFiniteSchema,
      })
      .strict(),
    returnsBps: altReturnsSchema,
    flow: z
      .object({
        '1m': altFlowWindowSchema,
        '5m': altFlowWindowSchema,
        '15m': altFlowWindowSchema,
        volumeAcceleration1m: nullableFiniteSchema,
      })
      .strict(),
    openInterest: z
      .object({
        current: z.number().nonnegative().nullable(),
        notional: z.number().nonnegative().nullable(),
        observedAt: epochMsSchema.nullable(),
        changesPercent: altOiChangesSchema,
      })
      .strict(),
    liquidations: z
      .object({
        '5m': altLiquidationWindowSchema,
        '15m': altLiquidationWindowSchema,
      })
      .strict(),
  })
  .strict();
export type AltAssetObservation = z.infer<typeof altAssetObservationSchema>;

export const dynamicBasketCandidateSchema = z
  .object({
    symbol: symbolSchema,
    baseAsset: z.string().trim().min(1).max(16),
    onboardDate: epochMsSchema.nullable(),
    quoteVolume24h: z.number().nonnegative(),
    openInterestNotional: z.number().nonnegative().nullable(),
    spreadBps: z.number().nonnegative().nullable(),
    tradeCount24h: z.number().int().nonnegative(),
    dataComplete: z.boolean(),
  })
  .strict();
export type DynamicBasketCandidate = z.infer<
  typeof dynamicBasketCandidateSchema
>;

export const dynamicBasketMemberSchema = z
  .object({
    symbol: symbolSchema,
    selectedAt: epochMsSchema,
    representativenessScore: z.number().min(0).max(1),
    components: z
      .object({
        quoteVolumePercentile: z.number().min(0).max(1),
        oiNotionalPercentile: z.number().min(0).max(1),
        spreadQualityPercentile: z.number().min(0).max(1),
        tradingActivityPercentile: z.number().min(0).max(1),
        dataHealthPercentile: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();
export type DynamicBasketMember = z.infer<typeof dynamicBasketMemberSchema>;

export const dynamicBasketSchema = z
  .object({
    version: z.literal(DYNAMIC_BASKET_VERSION),
    generatedAt: epochMsSchema,
    rebalanceIntervalMs: z.number().int().positive(),
    minimumResidenceMs: z.number().int().positive(),
    targetSize: z.number().int().min(1).max(20),
    eligibleCount: z.number().int().nonnegative(),
    members: z.array(dynamicBasketMemberSchema).max(20),
  })
  .strict();
export type DynamicBasket = z.infer<typeof dynamicBasketSchema>;

const breadthWindowSchema = z
  .object({
    validCount: z.number().int().nonnegative(),
    advancers: z.number().int().nonnegative(),
    decliners: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    medianReturnBps: nullableFiniteSchema,
    trimmedMeanReturnBps: nullableFiniteSchema,
    p25ReturnBps: nullableFiniteSchema,
    p75ReturnBps: nullableFiniteSchema,
    dispersionIqrBps: nullableFiniteSchema,
    liquidityWeightedReturnBps: nullableFiniteSchema,
  })
  .strict();

const directionalCountSchema = z
  .object({
    validCount: z.number().int().nonnegative(),
    positive: z.number().int().nonnegative(),
    negative: z.number().int().nonnegative(),
    neutral: z.number().int().nonnegative(),
    median: nullableFiniteSchema,
  })
  .strict();

const liquidationBreadthSchema = z
  .object({
    validCount: z.number().int().nonnegative(),
    symbolsWithObservedLongLiquidation: z.number().int().nonnegative(),
    symbolsWithObservedShortLiquidation: z.number().int().nonnegative(),
    observedLongNotional: z.number().nonnegative(),
    observedShortNotional: z.number().nonnegative(),
    coverage: z.literal('SNAPSHOT'),
  })
  .strict();

export const altMarketIntelligenceSchema = z
  .object({
    version: z.literal(ALT_MARKET_VERSION),
    generatedAt: epochMsSchema,
    objectiveOnly: z.literal(true),
    basket: dynamicBasketSchema,
    sentimentCore: z.array(altAssetObservationSchema),
    dynamic: z.array(altAssetObservationSchema),
    breadth: z
      .object({
        price: z
          .object({
            '1m': breadthWindowSchema,
            '3m': breadthWindowSchema,
            '5m': breadthWindowSchema,
            '15m': breadthWindowSchema,
            '1h': breadthWindowSchema,
          })
          .strict(),
        delta: z
          .object({
            '1m': directionalCountSchema,
            '5m': directionalCountSchema,
            '15m': directionalCountSchema,
          })
          .strict(),
        openInterest: z
          .object({
            '1m': directionalCountSchema,
            '5m': directionalCountSchema,
            '15m': directionalCountSchema,
          })
          .strict(),
        funding: directionalCountSchema,
        volumeAcceleration1m: directionalCountSchema,
        liquidations: z
          .object({
            '5m': liquidationBreadthSchema,
            '15m': liquidationBreadthSchema,
          })
          .strict(),
      })
      .strict(),
    relativeStrength: z
      .object({
        altMedianMinusBtcBps: z
          .object({
            '1m': nullableFiniteSchema,
            '3m': nullableFiniteSchema,
            '5m': nullableFiniteSchema,
            '15m': nullableFiniteSchema,
            '1h': nullableFiniteSchema,
          })
          .strict(),
        strongestVsBtc: z
          .array(
            z
              .object({ symbol: symbolSchema, differenceBps: finiteSchema })
              .strict(),
          )
          .max(3),
        weakestVsBtc: z
          .array(
            z
              .object({ symbol: symbolSchema, differenceBps: finiteSchema })
              .strict(),
          )
          .max(3),
      })
      .strict(),
    rotation: z
      .object({
        aggregateOiNotionalChangePercent: nullableFiniteSchema,
        topOiIncreaseSymbols: z.array(symbolSchema).max(3),
        topOiDecreaseSymbols: z.array(symbolSchema).max(3),
      })
      .strict(),
    evidenceHealth: z.array(evidenceHealthSchema).max(128),
    provenance: z.array(dataProvenanceSchema).max(64),
  })
  .strict();
export type AltMarketIntelligence = z.infer<typeof altMarketIntelligenceSchema>;
