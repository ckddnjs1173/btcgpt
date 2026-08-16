import { z } from 'zod';

import type { ExternalContextItem } from '../../shared/contracts';
import type {
  DataProvenance,
  EvidenceCoverage,
  MetricNature,
} from '../../shared/market-intelligence';

export type ExternalProviderKind =
  'DERIVATIVES_AGGREGATE' | 'ONCHAIN' | 'ESTIMATED_LIQUIDATION' | 'ETF';

export interface ProviderFetchResult<T> {
  providerId: string;
  kind: ExternalProviderKind;
  generatedAt: number;
  payload: T;
  provenance: DataProvenance[];
  items: ExternalContextItem[];
}

export interface ExternalIntelligenceProvider<T> {
  readonly providerId: string;
  readonly kind: ExternalProviderKind;
  fetch(now?: number): Promise<ProviderFetchResult<T>>;
}

export interface DerivativesAggregateProvider<
  T = unknown,
> extends ExternalIntelligenceProvider<T> {
  readonly kind: 'DERIVATIVES_AGGREGATE';
}

export interface OnchainProvider<
  T = unknown,
> extends ExternalIntelligenceProvider<T> {
  readonly kind: 'ONCHAIN';
}

export interface EstimatedLiquidationProvider<
  T = unknown,
> extends ExternalIntelligenceProvider<T> {
  readonly kind: 'ESTIMATED_LIQUIDATION';
}

export interface ETFProvider<
  T = unknown,
> extends ExternalIntelligenceProvider<T> {
  readonly kind: 'ETF';
}

export const estimatedLiquidationLevelSchema = z
  .object({
    price: z.number().positive(),
    estimatedLongLiquidationNotionalUsd: z.number().nonnegative().nullable(),
    estimatedShortLiquidationNotionalUsd: z.number().nonnegative().nullable(),
    metricNature: z.literal('ESTIMATED') satisfies z.ZodType<MetricNature>,
    coverage: z.enum(['SAMPLED', 'UNKNOWN']) satisfies z.ZodType<
      Extract<EvidenceCoverage, 'SAMPLED' | 'UNKNOWN'>
    >,
  })
  .strict();

export type EstimatedLiquidationLevel = z.infer<
  typeof estimatedLiquidationLevelSchema
>;
