import { describe, expect, it } from 'vitest';

import {
  armStructuredTrigger,
  structuredTriggerInputSchema,
} from '../../src/shared/trading/structured-trigger';
import { validatePositionAdjustment } from '../../src/shared/calculations/position-adjustment';

const baseContext = {
  side: 'LONG' as const,
  quantity: 0.02,
  markPrice: 100_000,
  filters: {
    tickSize: 0.1,
    stepSize: 0.001,
    minQuantity: 0.001,
    minNotional: 5,
  },
  costSettings: {
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
    exitSlippageBps: 2,
  },
  currentProtection: {
    stopLossQuantity: 0.02,
    takeProfitQuantity: 0.02,
  },
};

const triggerInput = {
  authoredBy: 'GPT' as const,
  triggerId: 'trigger-1',
  decisionId: 'decision-1',
  sourceSnapshotId: 'snapshot-1',
  triggerType: 'PRICE_CROSS' as const,
  referencePrice: 'MARK_PRICE' as const,
  triggerCondition: 'AT_OR_ABOVE' as const,
  triggerPrice: 101_000,
  confirmWindowSec: 0,
  invalidationCondition: 'AT_OR_BELOW' as const,
  invalidationPrice: 99_000,
  expiresAt: 2_000,
  maxChaseBps: 10,
};

describe('structured WAIT trigger contract', () => {
  it('requires GPT authorship and decision/snapshot lineage', () => {
    const parsed = structuredTriggerInputSchema.safeParse({
      ...triggerInput,
      triggerType: 'BREAKOUT_CONFIRM',
      confirmWindowSec: 10,
      invalidationPrice: 99_500,
      expiresAt: 2_000_000,
      maxChaseBps: 12,
    });
    expect(parsed.success).toBe(true);

    const localAuthored = structuredTriggerInputSchema.safeParse({
      ...(parsed.success ? parsed.data : {}),
      authoredBy: 'PROGRAM',
    });
    expect(localAuthored.success).toBe(false);
  });

  it('arms only future GPT-authored trigger contracts', () => {
    const trigger = armStructuredTrigger(triggerInput, 1_000);
    expect(trigger.state).toBe('ARMED');
    expect(trigger.conditionMatchedAt).toBeNull();
    expect(() =>
      armStructuredTrigger({ ...triggerInput, expiresAt: 999 }, 1_000),
    ).toThrow('TRIGGER_EXPIRES_AT_MUST_BE_IN_FUTURE');
  });
});

describe('deterministic position adjustment validation', () => {
  it('aligns a partial exit down and reports remaining protection over-coverage', () => {
    const result = validatePositionAdjustment(
      { action: 'PARTIAL_EXIT', requestedPercent: 33, exitOrderType: 'TAKER' },
      baseContext,
    );
    expect(result.valid).toBe(true);
    expect(result.requestedQuantity).toBeCloseTo(0.0066);
    expect(result.alignedQuantity).toBe(0.006);
    expect(result.remainingQuantity).toBe(0.014);
    expect(result.reduceOnlyRequired).toBe(true);
    expect(result.estimatedFee).toBeCloseTo(0.3);
    expect(result.warnings).toContain(
      'STOP_QUANTITY_EXCEEDS_REMAINING_POSITION',
    );
  });

  it('rejects a partial exit that would leave exchange-invalid dust', () => {
    const result = validatePositionAdjustment(
      { action: 'PARTIAL_EXIT', requestedQuantity: 0.019 },
      {
        ...baseContext,
        filters: { ...baseContext.filters, minQuantity: 0.005 },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('REMAINING_BELOW_MIN_QUANTITY');
  });

  it('aligns a long protective stop toward the current market', () => {
    const result = validatePositionAdjustment(
      { action: 'MOVE_STOP', stopPrice: 98_999.94 },
      baseContext,
    );
    expect(result.valid).toBe(true);
    expect(result.alignedStopPrice).toBe(99_000);
    expect(result.projectedProtection.stopLossCoverageRatio).toBe(1);
  });

  it('aligns TP prices and quantities without inventing full coverage', () => {
    const result = validatePositionAdjustment(
      {
        action: 'CHANGE_TP',
        targets: [
          { price: 101_000.06, requestedPercent: 30 },
          { price: 102_000.06, requestedPercent: 30 },
        ],
      },
      baseContext,
    );
    expect(result.valid).toBe(true);
    expect(result.targets.map((target) => target.alignedPrice)).toEqual([
      101_000, 102_000,
    ]);
    expect(result.targets.map((target) => target.alignedQuantity)).toEqual([
      0.006, 0.006,
    ]);
    expect(result.projectedProtection.takeProfitCoverageRatio).toBeCloseTo(0.6);
    expect(result.warnings).toContain('TAKE_PROFIT_COVERAGE_GAP');
  });

  it('rejects stop and target prices that are no longer protective/profitable', () => {
    const badStop = validatePositionAdjustment(
      { action: 'MOVE_STOP', stopPrice: 100_001 },
      baseContext,
    );
    expect(badStop.errors).toContain('STOP_MUST_REMAIN_PROTECTIVE');

    const badTarget = validatePositionAdjustment(
      {
        action: 'CHANGE_TP',
        targets: [{ price: 99_000, requestedPercent: 100 }],
      },
      baseContext,
    );
    expect(badTarget.errors).toContain('TARGET_1_MUST_BE_PROFIT_TAKING');
  });
});
