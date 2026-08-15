import { describe, expect, it } from 'vitest';

import type { Env } from '../../worker/src/index';
import { capturePlanLeverageFromSnapshot } from '../../worker/src/phase25-leverage';

describe('Phase 25 leverage telemetry', () => {
  it('captures active and last plan leverage without database triggers', async () => {
    const writes: unknown[][] = [];
    const env = {
      DB: {
        prepare(query: string) {
          expect(query).toContain('UPDATE decision_trade_lineage');
          expect(query).toContain('plan_leverage = ?');
          let values: unknown[] = [];
          return {
            bind(...nextValues: unknown[]) {
              values = nextValues;
              return this;
            },
            run() {
              writes.push(values);
              return Promise.resolve({ success: true });
            },
          };
        },
      },
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
    } as unknown as Env;

    const captured = await capturePlanLeverageFromSnapshot(env, {
      trading: {
        activePlan: { id: 'plan-active', leverage: 12 },
        lastPlan: { id: 'plan-last', leverage: 20 },
      },
    });

    expect(captured).toBe(2);
    expect(writes).toEqual([
      [12, 12, 'plan-active'],
      [20, 20, 'plan-last'],
    ]);
  });

  it('ignores plans that do not expose a valid leverage value', async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error('should not write');
        },
      },
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
    } as unknown as Env;

    const captured = await capturePlanLeverageFromSnapshot(env, {
      trading: {
        activePlan: { id: 'plan-active' },
        lastPlan: { id: 'plan-last', leverage: 0 },
      },
    });

    expect(captured).toBe(0);
  });
});
