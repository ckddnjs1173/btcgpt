import { describe, expect, it } from 'vitest';

import {
  cryptoAssetObservationBaseSchema,
  cryptoMarketFoundationSchema,
  evidenceHealthSchema,
  type CryptoAssetObservationBase,
} from '../../src/shared/market-intelligence';
import {
  buildEvidenceHealth,
  classifyEvidenceAge,
  evidenceBlocksEntry,
  MULTICOIN_FRESHNESS_THRESHOLDS,
} from '../../src/main/market/intelligence/freshness';
import { buildDataProvenance } from '../../src/main/market/intelligence/provenance';
import { MultiCoinObservationCache } from '../../src/main/market/multicoin/cache';

function observation(
  overrides: Partial<CryptoAssetObservationBase> = {},
): CryptoAssetObservationBase {
  const generatedAt = overrides.generatedAt ?? 1_200;
  const collectorReceivedAt = overrides.collectorReceivedAt ?? 1_100;
  const sourceEventAt = overrides.sourceEventAt ?? 1_000;
  const provenance = buildDataProvenance({
    source: 'BINANCE_USDM',
    venue: 'BINANCE_USDM',
    instrument: overrides.symbol ?? 'ETHUSDT',
    sourceEventAt,
    collectorReceivedAt,
    generatedAt,
    metricNature: 'OBSERVED',
    coverage: 'EXHAUSTIVE',
    status: 'NORMAL',
    now: generatedAt,
  });

  return cryptoAssetObservationBaseSchema.parse({
    symbol: 'ETHUSDT',
    baseAsset: 'ETH',
    quoteAsset: 'USDT',
    venue: 'BINANCE_USDM',
    instrumentType: 'PERPETUAL',
    tier: 'LEAD_CORE',
    generatedAt,
    sourceEventAt,
    collectorReceivedAt,
    provenance: [provenance],
    ...overrides,
  });
}

describe('market intelligence foundation', () => {
  it('tracks source, collector and processing timing independently', () => {
    const provenance = buildDataProvenance({
      source: 'BINANCE_USDM',
      venue: 'BINANCE_USDM',
      instrument: 'ETHUSDT',
      sourceEventAt: 1_000,
      collectorReceivedAt: 1_125,
      generatedAt: 1_200,
      now: 1_500,
      metricNature: 'OBSERVED',
      coverage: 'EXHAUSTIVE',
      status: 'NORMAL',
    });

    expect(provenance.ageMs).toBe(500);
    expect(provenance.collectorLagMs).toBe(125);
    expect(provenance.processingLagMs).toBe(75);
  });

  it('grades lead and dynamic evidence without making it entry-blocking', () => {
    const lead = MULTICOIN_FRESHNESS_THRESHOLDS.leadTradeBook;
    expect(classifyEvidenceAge(3_000, lead)).toBe('NORMAL');
    expect(classifyEvidenceAge(3_001, lead)).toBe('DEGRADED');
    expect(classifyEvidenceAge(8_001, lead)).toBe('STALE');

    const health = buildEvidenceHealth({
      sourceKey: 'lead:ETHUSDT:trade-book',
      ageMs: 20_000,
      threshold: lead,
    });
    expect(health.status).toBe('STALE');
    expect(health.requiredForEntry).toBe(false);
    expect(evidenceBlocksEntry(health)).toBe(false);
  });

  it('rejects auxiliary evidence that attempts to become a direct entry gate', () => {
    const parsed = evidenceHealthSchema.safeParse({
      sourceKey: 'lead:ETHUSDT',
      freshnessClass: 'AUX_DEGRADED',
      status: 'NORMAL',
      ageMs: 100,
      normalMaxAgeMs: 3_000,
      usableMaxAgeMs: 8_000,
      requiredForEntry: true,
      lastSuccessAt: 100,
      consecutiveFailures: 0,
      reconnectCount: 0,
    });

    expect(parsed.success).toBe(false);
  });

  it('keeps the market contract objective-only and rejects signal fields', () => {
    const base = observation();
    expect(
      cryptoAssetObservationBaseSchema.safeParse({
        ...base,
        bullishScore: 90,
      }).success,
    ).toBe(false);

    const foundation = cryptoMarketFoundationSchema.parse({
      version: 'crypto-market-v2',
      generatedAt: 1_200,
      objectiveOnly: true,
      universe: {
        execution: ['BTCUSDT'],
        lead: ['ETHUSDT', 'SOLUSDT'],
        sentiment: [],
        dynamic: [],
      },
      observations: [base],
      evidenceHealth: [],
    });

    expect(foundation.objectiveOnly).toBe(true);
  });

  it('does not allow an older observation to overwrite a newer one', () => {
    const cache = new MultiCoinObservationCache();
    const newer = observation({
      generatedAt: 2_000,
      collectorReceivedAt: 1_900,
    });
    const older = observation({
      generatedAt: 1_500,
      collectorReceivedAt: 1_450,
    });

    expect(cache.upsert(newer)).toBe('INSERTED');
    expect(cache.upsert(older)).toBe('IGNORED_OLDER');
    expect(
      cache.get({
        venue: 'BINANCE_USDM',
        instrumentType: 'PERPETUAL',
        symbol: 'ETHUSDT',
      })?.generatedAt,
    ).toBe(2_000);
  });
});
