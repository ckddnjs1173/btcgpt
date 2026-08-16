import { z } from 'zod';

import { dataProvenanceSchema } from './market-intelligence';

export const ONCHAIN_INTELLIGENCE_VERSION = 'onchain-v1' as const;

const epochMs = z.number().int().nonnegative();
const nullableNonnegative = z.number().finite().nonnegative().nullable();
const nullableCount = z.number().int().nonnegative().nullable();

export const mempoolObservationSchema = z
  .object({
    observedAt: epochMs,
    transactionCount: nullableCount,
    virtualSizeBytes: nullableCount,
    totalFeeSats: nullableNonnegative,
    recommendedFees: z
      .object({
        fastestFeeSatVb: nullableNonnegative,
        halfHourFeeSatVb: nullableNonnegative,
        hourFeeSatVb: nullableNonnegative,
        economyFeeSatVb: nullableNonnegative,
        minimumFeeSatVb: nullableNonnegative,
      })
      .strict(),
  })
  .strict();
export type MempoolObservation = z.infer<typeof mempoolObservationSchema>;

export const networkDailyObservationSchema = z
  .object({
    periodAt: epochMs,
    observedAt: epochMs,
    activeAddressCount: nullableNonnegative,
    transactionCount: nullableNonnegative,
    totalFeesBtc: nullableNonnegative,
    metricNature: z.literal('REVISED'),
  })
  .strict();
export type NetworkDailyObservation = z.infer<
  typeof networkDailyObservationSchema
>;

export const onchainIntelligenceV1Schema = z
  .object({
    version: z.literal(ONCHAIN_INTELLIGENCE_VERSION),
    generatedAt: epochMs,
    objectiveOnly: z.literal(true),
    role: z.literal('BACKGROUND_REGIME_ONLY'),
    mempool: mempoolObservationSchema.nullable(),
    networkDaily: networkDailyObservationSchema.nullable(),
    health: z
      .object({
        mempoolCollectionAgeMs: z.number().int().nonnegative().nullable(),
        networkDailyCollectionAgeMs: z.number().int().nonnegative().nullable(),
        networkDailyPeriodAgeMs: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    provenance: z.array(dataProvenanceSchema).max(8),
  })
  .strict();

export type OnchainIntelligenceV1 = z.infer<typeof onchainIntelligenceV1Schema>;
