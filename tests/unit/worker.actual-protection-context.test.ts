import { describe, expect, it } from 'vitest';

import type { Env } from '../../worker/src/index';
import { buildPositionManagementContext } from '../../worker/src/phase23-management';

const env = {
  UPLOADER_WRITE_KEY: 'upload',
  ACTION_READ_KEY: 'read',
} as Env;

function liveSnapshot(
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  markPrice: number,
  protectiveOrders: Array<Record<string, unknown>>,
) {
  return {
    decisionGates: { positionManagementAvailable: true },
    marketState: { markPrice },
    position: {
      source: 'BINANCE_READ_ONLY',
      side,
      quantity: 1,
      entryPrice,
      markPrice,
      leverage: 10,
      liquidationPrice: side === 'LONG' ? 90 : 110,
    },
    trading: {
      mode: 'LIVE_MANUAL',
      lifecycle: { stage: 'MANAGING' },
      activePlan: {
        id: 'plan-1',
        side,
        entry: entryPrice,
        stop: side === 'LONG' ? entryPrice - 2 : entryPrice + 2,
        targets: side === 'LONG' ? [entryPrice + 4] : [entryPrice - 4],
        leverage: 10,
      },
      activePaperTrade: null,
      activeLiveTrade: null,
      liveManual: {
        position: {
          side,
          quantity: 1,
          entryPrice,
          markPrice,
          leverage: 10,
          liquidationPrice: side === 'LONG' ? 90 : 110,
        },
        protectiveOrders,
        protectiveCoverage: {
          stopLossCoverageRatio: 1,
          takeProfitCoverageRatio: 1,
          hasFullStopCoverage: true,
          hasFullTakeProfitCoverage: true,
        },
        planMatchesPosition: true,
      },
    },
  };
}

describe('observed Binance protection in management context', () => {
  it('groups observed stop, take-profit and trailing orders without creating an action', async () => {
    const snapshot = liveSnapshot('LONG', 100, 101, [
      {
        side: 'SELL',
        type: 'STOP_MARKET',
        price: 0,
        stopPrice: 98.5,
        quantity: 0,
        reduceOnly: false,
        closePosition: true,
        protective: true,
        updatedAt: 1_000,
      },
      {
        side: 'SELL',
        type: 'TAKE_PROFIT_MARKET',
        price: 0,
        stopPrice: 105,
        quantity: 0.4,
        reduceOnly: true,
        closePosition: false,
        protective: true,
        updatedAt: 1_100,
      },
      {
        side: 'SELL',
        type: 'LIMIT',
        price: 107,
        stopPrice: 0,
        quantity: 0.6,
        reduceOnly: true,
        closePosition: false,
        protective: true,
        updatedAt: 1_200,
      },
      {
        side: 'SELL',
        type: 'TRAILING_STOP_MARKET',
        price: 0,
        stopPrice: 102,
        quantity: 1,
        reduceOnly: true,
        closePosition: false,
        protective: true,
        updatedAt: 1_300,
      },
    ]);

    const context = await buildPositionManagementContext(env, snapshot, 2_000);

    expect(context.status).toBe('ACTIVE');
    expect(context.actualProtection.source).toBe('BINANCE_READ_ONLY');
    expect(context.actualProtection.observedAt).toBe(1_300);
    expect(context.actualProtection.stopLosses).toEqual([
      expect.objectContaining({
        type: 'STOP_MARKET',
        triggerPrice: 98.5,
        effectiveQuantity: 1,
        closePosition: true,
      }),
    ]);
    expect(context.actualProtection.takeProfits).toEqual([
      expect.objectContaining({
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: 105,
        effectiveQuantity: 0.4,
      }),
      expect.objectContaining({
        type: 'LIMIT',
        price: 107,
        effectiveQuantity: 0.6,
      }),
    ]);
    expect(context.actualProtection.trailingStops).toEqual([
      expect.objectContaining({
        type: 'TRAILING_STOP_MARKET',
        triggerPrice: 102,
      }),
    ]);
    expect(context.actualProtection.otherProtectiveOrders).toEqual([]);
    expect(context).not.toHaveProperty('decision');
    expect(context).not.toHaveProperty('action');
  });

  it('recognizes a profitable reduce-only limit for a short position', async () => {
    const snapshot = liveSnapshot('SHORT', 100, 99, [
      {
        side: 'BUY',
        type: 'LIMIT',
        price: 95,
        stopPrice: 0,
        quantity: 1,
        reduceOnly: true,
        closePosition: false,
        protective: true,
        updatedAt: 2_000,
      },
    ]);

    const context = await buildPositionManagementContext(env, snapshot, 3_000);

    expect(context.actualProtection.takeProfits).toEqual([
      expect.objectContaining({ type: 'LIMIT', price: 95 }),
    ]);
  });
});
