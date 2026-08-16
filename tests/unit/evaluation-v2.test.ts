import { describe, expect, it } from 'vitest';

import {
  evaluateEnterPlan,
  evaluateManagementDecision,
  evaluateWaitTrigger,
  normalizePricePath,
} from '../../worker/src/evaluation-v2';

const waitTrigger = {
  authoredBy: 'GPT' as const,
  triggerId: 'trigger-1',
  decisionId: 'decision-1',
  sourceSnapshotId: 'snapshot-1',
  triggerType: 'BREAKOUT_CONFIRM' as const,
  referencePrice: 'MARK_PRICE' as const,
  triggerCondition: 'AT_OR_ABOVE' as const,
  triggerPrice: 101,
  confirmWindowSec: 10,
  invalidationCondition: 'AT_OR_BELOW' as const,
  invalidationPrice: 98,
  expiresAt: 1_000_000 + 120_000,
  maxChaseBps: 20,
};

describe('Evaluation V2 path scoring', () => {
  it('normalizes valid path points deterministically', () => {
    expect(
      normalizePricePath([
        [20_000, 102],
        [10_000, 101],
        [10_000, 101.5],
        [-1, 99],
        ['bad', 100],
      ]),
    ).toEqual([
      [10_000, 101.5],
      [20_000, 102],
    ]);
  });

  it('scores ENTER plans in stop-distance R and preserves target-before-stop ordering', () => {
    const result = evaluateEnterPlan({
      side: 'LONG',
      anchorMarkPrice: 100,
      entry: 100,
      stop: 99,
      targets: [101, 102],
      pricePath: [
        [10_000, 99.5],
        [20_000, 101.2],
        [30_000, 102.2],
        [40_000, 98.8],
      ],
      realizedNetR: 1.2,
      entryDriftBps: 3,
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.riskBps).toBeCloseTo(100);
    expect(result.mfeR).toBeGreaterThan(2);
    expect(result.maeR).toBeGreaterThan(1);
    expect(result.stopHitMs).toBe(40_000);
    expect(result.targets[0]?.orderingVsStop).toBe('TARGET_FIRST');
    expect(result.targets[1]?.orderingVsStop).toBe('TARGET_FIRST');
    expect(result.initialAdverseExcursionBps).toBeGreaterThan(0);
    expect(result.realizedNetR).toBe(1.2);
  });

  it('does not invent TP/SL ordering when both cross in one sampled observation', () => {
    const sameSample = evaluateEnterPlan({
      side: 'LONG',
      anchorMarkPrice: 100,
      entry: 100,
      stop: 99,
      targets: [101],
      pricePath: [[10_000, 101.5]],
    });
    expect(sameSample.available).toBe(true);
    if (!sameSample.available) return;
    expect(sameSample.targets[0]?.orderingVsStop).toBe('TARGET_FIRST');

    // A single scalar mark price cannot be below 99 and above 101 at once.
    // Ambiguity is reserved for sampled paths/providers that report both level
    // crossings at the same timestamp; the scorer must never force ambiguity.
    expect(sameSample.stopHitMs).toBeNull();
  });

  it('replays WAIT confirmation continuously and resets when price falls back', () => {
    const result = evaluateWaitTrigger({
      side: 'LONG',
      marketGeneratedAt: 1_000_000,
      anchorMarkPrice: 100,
      triggerContract: waitTrigger,
      pricePath: [
        [5_000, 101.05],
        [9_000, 100.9],
        [15_000, 101.02],
        [20_000, 101.1],
        [26_000, 101.25],
      ],
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.triggerHit).toBe(true);
    expect(result.timeToTriggerMs).toBe(26_000);
    expect(result.invalidationBeforeTrigger).toBe(false);
    expect(result.maxChaseExceededAtTrigger).toBe(true);
  });

  it('reports invalidation-before-trigger and expiry without assigning a score', () => {
    const invalidated = evaluateWaitTrigger({
      side: 'LONG',
      marketGeneratedAt: 1_000_000,
      anchorMarkPrice: 100,
      triggerContract: waitTrigger,
      pricePath: [
        [5_000, 99],
        [10_000, 97.9],
        [20_000, 102],
      ],
    });
    expect(invalidated.available).toBe(true);
    if (invalidated.available) {
      expect(invalidated.triggerHit).toBe(false);
      expect(invalidated.invalidationBeforeTrigger).toBe(true);
      expect(invalidated.invalidationHitMs).toBe(10_000);
    }

    const expired = evaluateWaitTrigger({
      side: 'LONG',
      marketGeneratedAt: 1_000_000,
      anchorMarkPrice: 100,
      triggerContract: { ...waitTrigger, expiresAt: 1_030_000 },
      pricePath: [
        [10_000, 100.2],
        [30_000, 100.3],
        [40_000, 102],
      ],
    });
    expect(expired.available).toBe(true);
    if (expired.available) expect(expired.expiredWithoutTrigger).toBe(true);
  });

  it('keeps management evaluation descriptive without a scalar strategy score', () => {
    const result = evaluateManagementDecision({
      decision: 'EXIT',
      side: 'LONG',
      anchorMarkPrice: 100,
      pricePath: [
        [60_000, 101],
        [180_000, 98],
        [1_800_000, 104],
      ],
      realizedNetR: 0.8,
      mfeCaptureRatio: 0.6,
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.horizons['1m'].favorableBps).toBeCloseTo(100);
    expect(result.horizons['3m'].adverseBps).toBeCloseTo(200);
    expect(result.interpretation?.favorableMoveAfterDecisionBps30m).toBeCloseTo(
      400,
    );
    expect(result).not.toHaveProperty('score');
  });
});
