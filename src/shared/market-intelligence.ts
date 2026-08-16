import { z } from 'zod';

export const CRYPTO_MARKET_VERSION = 'crypto-market-v2' as const;

export const evidenceFreshnessClassSchema = z.enum([
  'CORE_BLOCKING',
  'AUX_DEGRADED',
  'AUX_OPTIONAL',
]);
export type EvidenceFreshnessClass = z.infer<
  typeof evidenceFreshnessClassSchema
>;

export const evidenceStatusSchema = z.enum([
  'NORMAL',
  'DEGRADED',
  'STALE',
  'UNAVAILABLE',
]);
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

export const metricNatureSchema = z.enum([
  'OBSERVED',
  'DERIVED',
  'ESTIMATED',
  'POINT_IN_TIME',
  'REVISED',
]);
export type MetricNature = z.infer<typeof metricNatureSchema>;

export const evidenceCoverageSchema = z.enum([
  'EXHAUSTIVE',
  'SNAPSHOT',
  'SAMPLED',
  'UNKNOWN',
]);
export type EvidenceCoverage = z.infer<typeof evidenceCoverageSchema>;

const epochMsSchema = z.number().int().nonnegative();
const symbolSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Z0-9-]+$/);

export const dataProvenanceSchema = z
  .object({
    source: z.string().trim().min(1).max(64),
    venue: z.string().trim().min(1).max(64).nullable(),
    instrument: z.string().trim().min(1).max(64).nullable(),
    sourceEventAt: epochMsSchema.nullable(),
    collectorReceivedAt: epochMsSchema,
    generatedAt: epochMsSchema,
    ageMs: z.number().int().nonnegative(),
    collectorLagMs: z.number().int().nullable(),
    processingLagMs: z.number().int().nonnegative(),
    metricNature: metricNatureSchema,
    coverage: evidenceCoverageSchema,
    status: evidenceStatusSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.generatedAt < value.collectorReceivedAt) {
      context.addIssue({
        code: 'custom',
        path: ['generatedAt'],
        message: 'generatedAt must not precede collectorReceivedAt',
      });
    }
  });
export type DataProvenance = z.infer<typeof dataProvenanceSchema>;

export const evidenceHealthSchema = z
  .object({
    sourceKey: z.string().trim().min(1).max(128),
    freshnessClass: evidenceFreshnessClassSchema,
    status: evidenceStatusSchema,
    ageMs: z.number().int().nonnegative().nullable(),
    normalMaxAgeMs: z.number().int().positive(),
    usableMaxAgeMs: z.number().int().positive(),
    requiredForEntry: z.boolean(),
    lastSuccessAt: epochMsSchema.nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    reconnectCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.usableMaxAgeMs < value.normalMaxAgeMs) {
      context.addIssue({
        code: 'custom',
        path: ['usableMaxAgeMs'],
        message: 'usableMaxAgeMs must be >= normalMaxAgeMs',
      });
    }

    if (value.freshnessClass !== 'CORE_BLOCKING' && value.requiredForEntry) {
      context.addIssue({
        code: 'custom',
        path: ['requiredForEntry'],
        message: 'Auxiliary evidence must not directly block new entry',
      });
    }
  });
export type EvidenceHealth = z.infer<typeof evidenceHealthSchema>;

export const cryptoAssetTierSchema = z.enum([
  'EXECUTION_CORE',
  'LEAD_CORE',
  'SENTIMENT_CORE',
  'DYNAMIC',
]);
export type CryptoAssetTier = z.infer<typeof cryptoAssetTierSchema>;

export const cryptoAssetObservationBaseSchema = z
  .object({
    symbol: symbolSchema,
    baseAsset: z.string().trim().min(1).max(16),
    quoteAsset: z.enum(['USDT', 'USD']),
    venue: z.string().trim().min(1).max(64),
    instrumentType: z.enum(['PERPETUAL', 'SPOT']),
    tier: cryptoAssetTierSchema,
    generatedAt: epochMsSchema,
    sourceEventAt: epochMsSchema.nullable(),
    collectorReceivedAt: epochMsSchema,
    provenance: z.array(dataProvenanceSchema).min(1).max(32),
  })
  .strict();
export type CryptoAssetObservationBase = z.infer<
  typeof cryptoAssetObservationBaseSchema
>;

export const cryptoMarketFoundationSchema = z
  .object({
    version: z.literal(CRYPTO_MARKET_VERSION),
    generatedAt: epochMsSchema,
    objectiveOnly: z.literal(true),
    universe: z
      .object({
        execution: z.array(z.literal('BTCUSDT')).length(1),
        lead: z.array(symbolSchema).max(8),
        sentiment: z.array(symbolSchema).max(20),
        dynamic: z.array(symbolSchema).max(20),
      })
      .strict(),
    observations: z.array(cryptoAssetObservationBaseSchema).max(64),
    evidenceHealth: z.array(evidenceHealthSchema).max(128),
  })
  .strict();
export type CryptoMarketFoundation = z.infer<
  typeof cryptoMarketFoundationSchema
>;
