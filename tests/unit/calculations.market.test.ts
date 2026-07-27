import { describe, expect, it } from 'vitest';

import {
  atr,
  estimateSlippage,
  orderBookImbalance,
  pivotLevels,
  vwap,
  volumeZScore,
} from '../../src/shared/calculations/market';
import {
  breakevenExitPrice,
  calculatePositionPlan,
  signedFundingPayment,
  validateRiskQuantity,
} from '../../src/shared/calculations/costs';

describe('objective market calculations', () => {
  const candles = Array.from({ length: 30 }, (_, index) => ({
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 10 + index,
  }));

  it('calculates ATR, VWAP, volume z-score, and pivots', () => {
    expect(atr(candles)).toBeCloseTo(2);
    expect(vwap(candles)).toBeGreaterThan(100);
    expect(volumeZScore(candles.map((item) => item.volume))).toBeGreaterThan(1);
    expect(pivotLevels(110, 90, 100).pivot).toBe(100);
  });

  it('calculates depth imbalance and slippage', () => {
    expect(orderBookImbalance([[100, 2]], [[101, 1]])).toBeGreaterThan(0);
    expect(
      estimateSlippage('BUY', 2, [
        [100, 1],
        [101, 1],
      ])?.averagePrice,
    ).toBe(100.5);
  });

  it('handles long and short costs and risk rounding', () => {
    expect(
      calculatePositionPlan({
        side: 'LONG',
        entry: 30_000,
        exit: 31_000,
        quantity: 0.1,
        entryFeeRate: 0.0002,
        exitFeeRate: 0.0005,
      }).netPnl,
    ).toBeGreaterThan(0);
    expect(
      calculatePositionPlan({
        side: 'SHORT',
        entry: 30_000,
        exit: 29_000,
        quantity: 0.1,
        entryFeeRate: 0.0002,
        exitFeeRate: 0.0005,
      }).netPnl,
    ).toBeGreaterThan(0);
    const risk = validateRiskQuantity({
      entry: 30_000,
      stop: 29_500,
      maxLossUsdt: 50,
      entryFeeRate: 0.0002,
      exitFeeRate: 0.0005,
      slippageRate: 0.0001,
      stepSize: 0.001,
      minQuantity: 0.001,
      minNotional: 5,
    });
    expect(risk.valid).toBe(true);
    expect(risk.quantity * 30_000).toBeGreaterThanOrEqual(5);
    expect(breakevenExitPrice('LONG', 30_000, 0.0002, 0.0005)).toBeGreaterThan(
      30_000,
    );
    expect(signedFundingPayment('LONG', 1_000, 0.0001)).toBe(0.1);
    expect(signedFundingPayment('SHORT', 1_000, 0.0001)).toBe(-0.1);
    expect(signedFundingPayment('LONG', 1_000, -0.0001)).toBe(-0.1);
  });
});
