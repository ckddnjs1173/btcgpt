import { describe, expect, it } from 'vitest';

import { syncDecisionLineageFromSnapshot } from '../../worker/src/phase13-lineage';
import type { Env } from '../../worker/src/index';

type DecisionCandidate = {
  decisionId: string;
  recordedAt: number;
  side: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  targetsJson: string;
};

type StoredLineage = {
  decisionId: string;
  planId: string;
  linkedAt: number;
  planStatus: string;
  monitoringState: string | null;
  tradeId: string | null;
  tradeStatus: string | null;
  realizedNetPnl: number | null;
  payload: string;
};

class LineageD1 {
  private readonly lineages = new Map<string, StoredLineage>();

  constructor(private readonly decisions: DecisionCandidate[]) {}

  prepare(query: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...nextValues: unknown[]) => {
        values = nextValues;
        return statement;
      },
      first: <T>(): Promise<T | null> => {
        if (query.includes('FROM decision_trade_lineage WHERE plan_id')) {
          const lineage = this.lineages.get(String(values[0]));
          return Promise.resolve(
            lineage
              ? ({
                  decisionId: lineage.decisionId,
                  linkedAt: lineage.linkedAt,
                } as T)
              : null,
          );
        }
        if (query.includes('FROM decision_log')) {
          const [side, entry, stop, targetsJson, start, end] = values as [
            'LONG' | 'SHORT',
            number,
            number,
            string,
            number,
            number,
          ];
          const match = [...this.decisions]
            .filter(
              (candidate) =>
                candidate.side === side &&
                candidate.entry === entry &&
                candidate.stop === stop &&
                candidate.targetsJson === targetsJson &&
                candidate.recordedAt >= start &&
                candidate.recordedAt <= end,
            )
            .sort((left, right) => right.recordedAt - left.recordedAt)[0];
          return Promise.resolve(
            match
              ? ({
                  decisionId: match.decisionId,
                  recordedAt: match.recordedAt,
                } as T)
              : null,
          );
        }
        return Promise.resolve(null);
      },
      run: () => {
        if (query.includes('INSERT INTO decision_trade_lineage')) {
          const [
            decisionId,
            planId,
            ,
            linkedAt,
            ,
            planStatus,
            monitoringState,
            ,
            ,
            ,
            ,
            tradeId,
            tradeStatus,
            ,
            ,
            realizedNetPnl,
            ,
            ,
            ,
            ,
            ,
            ,
            payload,
          ] = values;
          this.lineages.set(String(planId), {
            decisionId: String(decisionId),
            planId: String(planId),
            linkedAt: Number(linkedAt),
            planStatus: String(planStatus),
            monitoringState:
              monitoringState === null ? null : String(monitoringState),
            tradeId: tradeId === null ? null : String(tradeId),
            tradeStatus: tradeStatus === null ? null : String(tradeStatus),
            realizedNetPnl:
              realizedNetPnl === null ? null : Number(realizedNetPnl),
            payload: String(payload),
          });
        }
        return Promise.resolve({ success: true });
      },
    };
    return statement;
  }

  get(planId: string): StoredLineage | null {
    return this.lineages.get(planId) ?? null;
  }
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    mode: 'PAPER',
    status: 'LOCKED',
    side: 'LONG',
    entry: 63_100,
    stop: 62_800,
    targets: [63_600, 64_000],
    lockedAt: 2_000_000,
    monitoring: {
      state: 'WATCHING',
      triggeredAt: null,
      invalidatedAt: null,
      expiredAt: null,
      cancelledAt: null,
    },
    ...overrides,
  };
}

function snapshot(trading: Record<string, unknown>) {
  return { trading };
}

describe('phase 13B decision trade lineage', () => {
  it('links an exact validated decision to a plan and later attaches its trade outcome', async () => {
    const database = new LineageD1([
      {
        decisionId: 'decision-enter-1',
        recordedAt: 1_990_000,
        side: 'LONG',
        entry: 63_100,
        stop: 62_800,
        targetsJson: JSON.stringify([63_600, 64_000]),
      },
    ]);
    const env = {
      DB: database,
      UPLOADER_WRITE_KEY: 'upload-secret',
      ACTION_READ_KEY: 'read-secret',
    } as unknown as Env;

    expect(
      await syncDecisionLineageFromSnapshot(
        env,
        snapshot({ activePlan: plan(), lastPlan: null }),
        2_001_000,
      ),
    ).toBe(1);
    expect(database.get('plan-1')).toMatchObject({
      decisionId: 'decision-enter-1',
      planStatus: 'LOCKED',
      monitoringState: 'WATCHING',
      tradeId: null,
    });

    const triggeredPlan = plan({
      status: 'ENTERED',
      monitoring: {
        state: 'TRIGGERED',
        triggeredAt: 2_002_000,
        invalidatedAt: null,
        expiredAt: null,
        cancelledAt: null,
      },
    });
    const trade = {
      id: 'paper-1',
      planId: 'plan-1',
      status: 'CLOSED',
      openedAt: 2_003_000,
      closedAt: 2_010_000,
      realizedNetPnl: 12.5,
      realizedGrossPnl: 15,
      feesPaid: 1.5,
      slippagePaid: 1,
      fundingPaid: 0,
    };
    expect(
      await syncDecisionLineageFromSnapshot(
        env,
        snapshot({
          activePlan: null,
          lastPlan: triggeredPlan,
          activePaperTrade: null,
          lastCompletedPaperTrade: trade,
        }),
        2_011_000,
      ),
    ).toBe(1);
    expect(database.get('plan-1')).toMatchObject({
      decisionId: 'decision-enter-1',
      planStatus: 'ENTERED',
      monitoringState: 'TRIGGERED',
      tradeId: 'paper-1',
      tradeStatus: 'CLOSED',
      realizedNetPnl: 12.5,
    });
  });

  it('does not guess a lineage when the locked values differ from the GPT decision', async () => {
    const database = new LineageD1([
      {
        decisionId: 'decision-enter-1',
        recordedAt: 1_990_000,
        side: 'LONG',
        entry: 63_100,
        stop: 62_800,
        targetsJson: JSON.stringify([63_600, 64_000]),
      },
    ]);
    const env = {
      DB: database,
      UPLOADER_WRITE_KEY: 'upload-secret',
      ACTION_READ_KEY: 'read-secret',
    } as unknown as Env;

    expect(
      await syncDecisionLineageFromSnapshot(
        env,
        snapshot({
          activePlan: plan({ entry: 63_110 }),
          lastPlan: null,
        }),
        2_001_000,
      ),
    ).toBe(0);
    expect(database.get('plan-1')).toBeNull();
  });
});
