import { describe, expect, it } from 'vitest';

import { aggregateResearchDecisionCohorts } from '../../worker/src/research-decision-cohorts';

function snapshot(input: {
  volatility: number;
  return12: number;
  fullCore?: boolean;
}) {
  const fullCore = input.fullCore ?? true;
  return JSON.stringify({
    version: 'decision-context-v1',
    completeness: {
      cryptoMarketAvailable: true,
      leadAssetsAvailable: fullCore ? 2 : 1,
      dynamicAssetCount: fullCore ? 6 : 0,
      crossMarket: fullCore ? 1 : 0,
      externalAvailable: fullCore,
      optionsAvailable: true,
      onchainAvailable: false,
    },
    btcCore: {
      timeframes: {
        '15m': { realizedVolatility: input.volatility },
        '1h': { return12: input.return12 },
      },
    },
  });
}

function score(
  decisionClass:
    | 'ENTER'
    | 'WAIT'
    | 'ABSTAIN'
    | 'DATA_BLOCKED'
    | 'POSITION_MANAGEMENT',
) {
  const decisionEvaluation =
    decisionClass === 'ENTER'
      ? {
          available: true,
          mfeR: 1.4,
          maeR: 0.6,
          initialAdverseExcursionBps: 12,
          timeToMfeMs: 90_000,
          timeToMaeMs: 30_000,
          targets: [{ orderingVsStop: 'TARGET_FIRST' }],
        }
      : decisionClass === 'WAIT'
        ? {
            available: true,
            triggerHit: true,
            invalidationBeforeTrigger: false,
            expiredWithoutTrigger: false,
            timeToTriggerMs: 45_000,
            maxChaseExceededAtTrigger: false,
            postTrigger15m: { favorableBps: 80, adverseBps: 25 },
          }
        : decisionClass === 'POSITION_MANAGEMENT'
          ? {
              available: true,
              horizons: {
                '30m': { favorableBps: 70, adverseBps: 35 },
              },
            }
          : { available: false };
  return JSON.stringify({
    evaluatorVersion: 'eval-v2',
    decisionClass,
    decisionEvaluation,
  });
}

describe('research decision cohorts', () => {
  it('keeps decision mix explicit while stratifying frozen contexts descriptively', () => {
    const report = aggregateResearchDecisionCohorts([
      {
        decisionId: 'd-enter',
        scorePayload: score('ENTER'),
        snapshotPayload: snapshot({ volatility: 10, return12: 5 }),
      },
      {
        decisionId: 'd-wait',
        scorePayload: score('WAIT'),
        snapshotPayload: snapshot({ volatility: 20, return12: -3 }),
      },
      {
        decisionId: 'd-abstain',
        scorePayload: score('ABSTAIN'),
        snapshotPayload: snapshot({
          volatility: 30,
          return12: 0,
          fullCore: false,
        }),
      },
      {
        decisionId: 'd-management',
        scorePayload: score('POSITION_MANAGEMENT'),
        snapshotPayload: snapshot({ volatility: 40, return12: 8 }),
      },
      {
        decisionId: 'd-blocked',
        scorePayload: score('DATA_BLOCKED'),
        snapshotPayload: JSON.stringify({ version: 'legacy-market-v1' }),
      },
    ]);

    expect(report.version).toBe('research-decision-cohorts-v1');
    expect(report.decisionMix.samples).toBe(5);
    expect(report.decisionMix.counts.ENTER).toBe(1);
    expect(report.decisionMix.counts.WAIT).toBe(1);
    expect(report.decisionMix.counts.ABSTAIN).toBe(1);
    expect(report.decisionMix.counts.DATA_BLOCKED).toBe(1);
    expect(report.decisionMix.counts.POSITION_MANAGEMENT).toBe(1);
    expect(report.decisionMix.rates.ENTER).toBeCloseTo(0.2, 8);

    const full = report.completenessCohorts.find(
      (cohort) => cohort.cohort === 'FULL_CORE',
    );
    const partial = report.completenessCohorts.find(
      (cohort) => cohort.cohort === 'PARTIAL_CORE',
    );
    const legacy = report.completenessCohorts.find(
      (cohort) => cohort.cohort === 'LEGACY_INPUT',
    );
    expect(full?.runCount).toBe(3);
    expect(partial?.runCount).toBe(1);
    expect(legacy?.runCount).toBe(1);
    expect(full?.pathQuality.enter.samples).toBe(1);
    expect(full?.pathQuality.wait.samples).toBe(1);

    expect(report.regimeDefinition.thresholdCaseSamples).toBe(4);
    expect(report.regimeDefinition.lowerTercile).not.toBeNull();
    expect(report.regimeDefinition.upperTercile).not.toBeNull();
    expect(report.regimeCohorts.some((cohort) => cohort.cohort.includes('LOW_RELATIVE'))).toBe(
      true,
    );
    expect(report.regimeCohorts.some((cohort) => cohort.cohort.includes('HIGH_RELATIVE'))).toBe(
      true,
    );
    expect(report.policy.tradingSignal).toBe(false);
    expect(report.policy.automaticPromotion).toBe(false);
    expect(report.policy.scalarWinnerScore).toBe(false);
  });

  it('does not invent relative volatility bands with fewer than three frozen cases', () => {
    const report = aggregateResearchDecisionCohorts([
      {
        decisionId: 'd-1',
        scorePayload: score('ENTER'),
        snapshotPayload: snapshot({ volatility: 10, return12: 1 }),
      },
      {
        decisionId: 'd-2',
        scorePayload: score('WAIT'),
        snapshotPayload: snapshot({ volatility: 20, return12: -1 }),
      },
    ]);

    expect(report.regimeDefinition.lowerTercile).toBeNull();
    expect(report.regimeDefinition.upperTercile).toBeNull();
    expect(report.regimeCohorts.every((cohort) => cohort.cohort.startsWith('UNAVAILABLE|'))).toBe(
      true,
    );
  });

  it('preserves malformed score and snapshot counts instead of fabricating cohorts', () => {
    const report = aggregateResearchDecisionCohorts([
      {
        decisionId: 'bad-score',
        scorePayload: '{',
        snapshotPayload: snapshot({ volatility: 10, return12: 1 }),
      },
      {
        decisionId: 'bad-snapshot',
        scorePayload: score('ABSTAIN'),
        snapshotPayload: '{',
      },
    ]);

    expect(report.rows.total).toBe(2);
    expect(report.rows.parsedEvalV2Scores).toBe(1);
    expect(report.rows.invalidScorePayloads).toBe(1);
    expect(report.rows.invalidSnapshotPayloads).toBe(1);
    expect(report.completenessCohorts[0]?.cohort).toBe('LEGACY_INPUT');
  });
});
