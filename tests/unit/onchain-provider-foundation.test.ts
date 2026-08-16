import { describe, expect, it } from 'vitest';

import { buildOnchainIntelligenceV1 } from '../../src/main/external/onchain-v1';
import { estimatedLiquidationLevelSchema } from '../../src/main/external/provider-contracts';
import {
  mempoolObservationSchema,
  networkDailyObservationSchema,
} from '../../src/shared/onchain-intelligence';

describe('on-chain V1 and provider boundaries', () => {
  it('keeps mempool observed and daily network evidence revision-aware and background-only', () => {
    const now = Date.UTC(2026, 7, 17, 0, 0, 0);
    const mempool = mempoolObservationSchema.parse({
      observedAt: now - 5_000,
      transactionCount: 123_456,
      virtualSizeBytes: 222_000_000,
      totalFeeSats: null,
      recommendedFees: {
        fastestFeeSatVb: 8,
        halfHourFeeSatVb: 6,
        hourFeeSatVb: 5,
        economyFeeSatVb: null,
        minimumFeeSatVb: 1,
      },
    });
    const networkDaily = networkDailyObservationSchema.parse({
      periodAt: now - 24 * 60 * 60_000,
      observedAt: now - 60_000,
      activeAddressCount: 700_000,
      transactionCount: null,
      totalFeesBtc: 3.25,
      metricNature: 'REVISED',
    });
    const result = buildOnchainIntelligenceV1({ now, mempool, networkDaily });

    expect(result?.version).toBe('onchain-v1');
    expect(result?.objectiveOnly).toBe(true);
    expect(result?.role).toBe('BACKGROUND_REGIME_ONLY');
    expect(result?.mempool?.totalFeeSats).toBeNull();
    expect(result?.networkDaily?.transactionCount).toBeNull();
    expect(result?.health.mempoolCollectionAgeMs).toBe(5_000);
    expect(result?.health.networkDailyCollectionAgeMs).toBe(60_000);
    expect(result?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'MEMPOOL_SPACE',
          metricNature: 'OBSERVED',
          coverage: 'SNAPSHOT',
        }),
        expect.objectContaining({
          source: 'COIN_METRICS_COMMUNITY',
          metricNature: 'REVISED',
          coverage: 'SNAPSHOT',
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /longSignal|shortSignal|buySignal|sellSignal|bullishScore|bearishScore|entryRecommendation/i,
    );
  });

  it('returns no structured on-chain context until at least one source exists', () => {
    expect(
      buildOnchainIntelligenceV1({
        now: 1_000,
        mempool: null,
        networkDaily: null,
      }),
    ).toBeNull();
  });

  it('forces estimated liquidation providers to remain explicitly estimated', () => {
    const valid = estimatedLiquidationLevelSchema.parse({
      price: 100_000,
      estimatedLongLiquidationNotionalUsd: 5_000_000,
      estimatedShortLiquidationNotionalUsd: null,
      metricNature: 'ESTIMATED',
      coverage: 'UNKNOWN',
    });
    expect(valid.metricNature).toBe('ESTIMATED');
    expect(
      estimatedLiquidationLevelSchema.safeParse({
        ...valid,
        observedLongLiquidationNotionalUsd: 5_000_000,
      }).success,
    ).toBe(false);
  });
});
