import { describe, expect, it } from 'vitest';

import { aggregateEvalV2PathQuality } from '../../worker/src/eval-v2-path-summary';

function row(decisionId: string, score: unknown) {
  return { decisionId, scorePayload: JSON.stringify(score) };
}

describe('eval-v2 path quality aggregation', () => {
  it('aggregates ENTER MFE/MAE and TP1 ordering without a scalar score', () => {
    const result = aggregateEvalV2PathQuality([
      row('enter-1', {
        evaluatorVersion: 'eval-v2',
        decisionClass: 'ENTER',
        decisionEvaluation: {
          available: true,
          mfeR: 2,
          maeR: 0.5,
          initialAdverseExcursionBps: 12,
          timeToMfeMs: 40_000,
          timeToMaeMs: 10_000,
          targets: [{ orderingVsStop: 'TARGET_FIRST' }],
        },
      }),
      row('enter-2', {
        evaluatorVersion: 'eval-v2',
        decisionClass: 'ENTER',
        decisionEvaluation: {
          available: true,
          mfeR: 1,
          maeR: 1.5,
          initialAdverseExcursionBps: 30,
          timeToMfeMs: 80_000,
          timeToMaeMs: 20_000,
          targets: [{ orderingVsStop: 'STOP_FIRST' }],
        },
      }),
    ]);

    expect(result.enter.samples).toBe(2);
    expect(result.enter.mfeR.mean).toBe(1.5);
    expect(result.enter.maeR.mean).toBe(1);
    expect(result.enter.initialAdverseExcursionBps.mean).toBe(21);
    expect(result.enter.timeToMfeMs.mean).toBe(60_000);
    expect(result.enter.tp1Ordering.resolvedSamples).toBe(2);
    expect(result.enter.tp1Ordering.targetFirstRate).toBe(0.5);
    expect(result.enter.tp1Ordering.stopFirstRate).toBe(0.5);
    expect(result.policy.scalarScore).toBe(false);
    expect(result.policy.automaticPromotion).toBe(false);
  });

  it('aggregates WAIT trigger, invalidation, expiry, chase, and post-trigger vectors', () => {
    const result = aggregateEvalV2PathQuality([
      row('wait-1', {
        evaluatorVersion: 'eval-v2',
        decisionClass: 'WAIT',
        decisionEvaluation: {
          available: true,
          triggerHit: true,
          timeToTriggerMs: 25_000,
          invalidationBeforeTrigger: false,
          expiredWithoutTrigger: false,
          maxChaseExceededAtTrigger: true,
          postTrigger15m: { favorableBps: 80, adverseBps: 20 },
        },
      }),
      row('wait-2', {
        evaluatorVersion: 'eval-v2',
        decisionClass: 'WAIT',
        decisionEvaluation: {
          available: true,
          triggerHit: false,
          invalidationBeforeTrigger: true,
          expiredWithoutTrigger: false,
          maxChaseExceededAtTrigger: null,
          postTrigger15m: null,
        },
      }),
      row('wait-3', {
        evaluatorVersion: 'eval-v2',
        decisionClass: 'WAIT',
        decisionEvaluation: {
          available: true,
          triggerHit: false,
          invalidationBeforeTrigger: false,
          expiredWithoutTrigger: true,
          maxChaseExceededAtTrigger: null,
          postTrigger15m: null,
        },
      }),
    ]);

    expect(result.wait.samples).toBe(3);
    expect(result.wait.triggerHitRate).toBeCloseTo(1 / 3);
    expect(result.wait.invalidationBeforeTriggerRate).toBeCloseTo(1 / 3);
    expect(result.wait.expiredWithoutTriggerRate).toBeCloseTo(1 / 3);
    expect(result.wait.timeToTriggerMs.mean).toBe(25_000);
    expect(result.wait.chase.samples).toBe(1);
    expect(result.wait.chase.maxChaseExceededRate).toBe(1);
    expect(result.wait.postTrigger15m.favorableBps.mean).toBe(80);
    expect(result.wait.postTrigger15m.adverseBps.mean).toBe(20);
  });

  it('keeps position-management path quality separate from entry and wait', () => {
    const result = aggregateEvalV2PathQuality([
      row('manage-1', {
        evaluatorVersion: 'eval-v2',
        decisionClass: 'POSITION_MANAGEMENT',
        decisionEvaluation: {
          available: true,
          horizons: {
            '30m': { favorableBps: 120, adverseBps: 45 },
          },
        },
      }),
      row('manage-2', {
        evaluatorVersion: 'eval-v2',
        decisionClass: 'POSITION_MANAGEMENT',
        decisionEvaluation: {
          available: true,
          horizons: {
            '30m': { favorableBps: 60, adverseBps: 25 },
          },
        },
      }),
    ]);

    expect(result.management.samples).toBe(2);
    expect(result.management.favorable30mBps.mean).toBe(90);
    expect(result.management.adverse30mBps.mean).toBe(35);
    expect(result.enter.samples).toBe(0);
    expect(result.wait.samples).toBe(0);
  });

  it('counts malformed and unavailable score payloads without fabricating metrics', () => {
    const result = aggregateEvalV2PathQuality([
      { decisionId: 'bad-json', scorePayload: '{bad' },
      row('legacy', {
        evaluatorVersion: 'eval-v1',
        decisionClass: 'ENTER',
        decisionEvaluation: { available: true, mfeR: 99 },
      }),
      row('unavailable', {
        evaluatorVersion: 'eval-v2',
        decisionClass: 'ENTER',
        decisionEvaluation: { available: false },
      }),
    ]);

    expect(result.rows.total).toBe(3);
    expect(result.rows.invalidScorePayloads).toBe(1);
    expect(result.rows.parsedEvalV2Scores).toBe(1);
    expect(result.rows.unavailableDecisionEvaluations).toBe(1);
    expect(result.enter.samples).toBe(0);
    expect(result.enter.mfeR.mean).toBeNull();
  });
});
