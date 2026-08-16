import {
  evidenceHealthSchema,
  type EvidenceFreshnessClass,
  type EvidenceHealth,
  type EvidenceStatus,
} from '../../../shared/market-intelligence';

export interface FreshnessThreshold {
  freshnessClass: EvidenceFreshnessClass;
  normalMaxAgeMs: number;
  usableMaxAgeMs: number;
  requiredForEntry: boolean;
}

/**
 * Initial SLOs for auxiliary multi-asset evidence. These do not replace the
 * existing BTC core freshness gates in MarketCache / MarketSnapshot.
 */
export const MULTICOIN_FRESHNESS_THRESHOLDS = {
  leadTradeBook: {
    freshnessClass: 'AUX_DEGRADED',
    normalMaxAgeMs: 3_000,
    usableMaxAgeMs: 8_000,
    requiredForEntry: false,
  },
  leadOpenInterest: {
    freshnessClass: 'AUX_DEGRADED',
    normalMaxAgeMs: 20_000,
    usableMaxAgeMs: 90_000,
    requiredForEntry: false,
  },
  dynamicPrice: {
    freshnessClass: 'AUX_OPTIONAL',
    normalMaxAgeMs: 5_000,
    usableMaxAgeMs: 15_000,
    requiredForEntry: false,
  },
  dynamicOpenInterest: {
    freshnessClass: 'AUX_OPTIONAL',
    normalMaxAgeMs: 60_000,
    usableMaxAgeMs: 180_000,
    requiredForEntry: false,
  },
} as const satisfies Record<string, FreshnessThreshold>;

function validateThreshold(threshold: FreshnessThreshold): void {
  if (!Number.isFinite(threshold.normalMaxAgeMs) || threshold.normalMaxAgeMs <= 0)
    throw new Error('INVALID_NORMAL_MAX_AGE');
  if (!Number.isFinite(threshold.usableMaxAgeMs) || threshold.usableMaxAgeMs <= 0)
    throw new Error('INVALID_USABLE_MAX_AGE');
  if (threshold.usableMaxAgeMs < threshold.normalMaxAgeMs)
    throw new Error('INVALID_FRESHNESS_RANGE');
  if (
    threshold.freshnessClass !== 'CORE_BLOCKING' &&
    threshold.requiredForEntry
  )
    throw new Error('AUXILIARY_EVIDENCE_CANNOT_BLOCK_ENTRY');
}

export function classifyEvidenceAge(
  ageMs: number | null,
  threshold: FreshnessThreshold,
): EvidenceStatus {
  validateThreshold(threshold);
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0)
    return 'UNAVAILABLE';
  if (ageMs <= threshold.normalMaxAgeMs) return 'NORMAL';
  if (ageMs <= threshold.usableMaxAgeMs) return 'DEGRADED';
  return 'STALE';
}

export function buildEvidenceHealth(input: {
  sourceKey: string;
  ageMs: number | null;
  threshold: FreshnessThreshold;
  lastSuccessAt?: number | null;
  consecutiveFailures?: number;
  reconnectCount?: number;
}): EvidenceHealth {
  validateThreshold(input.threshold);
  return evidenceHealthSchema.parse({
    sourceKey: input.sourceKey,
    freshnessClass: input.threshold.freshnessClass,
    status: classifyEvidenceAge(input.ageMs, input.threshold),
    ageMs: input.ageMs,
    normalMaxAgeMs: input.threshold.normalMaxAgeMs,
    usableMaxAgeMs: input.threshold.usableMaxAgeMs,
    requiredForEntry: input.threshold.requiredForEntry,
    lastSuccessAt: input.lastSuccessAt ?? null,
    consecutiveFailures: input.consecutiveFailures ?? 0,
    reconnectCount: input.reconnectCount ?? 0,
  });
}

export function evidenceBlocksEntry(health: EvidenceHealth): boolean {
  return (
    health.freshnessClass === 'CORE_BLOCKING' &&
    health.requiredForEntry &&
    (health.status === 'STALE' || health.status === 'UNAVAILABLE')
  );
}
