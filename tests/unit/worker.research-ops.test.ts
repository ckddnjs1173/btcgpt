import { describe, expect, it } from 'vitest';

import type { Env } from '../../worker/src/index';
import { handleResearchOpsRequest } from '../../worker/src/research-ops';

function request(path: string, authorized = true) {
  return new Request(`https://example.com${path}`, {
    headers: authorized ? { authorization: 'Bearer read' } : {},
  });
}

type ReadinessBody = {
  schema: { performanceResearch: string; requiredMigration: string | null };
  inventory: { decisions: number; closedLinkedTradesWithNetR: number };
  nextActions: string[];
};

type FeedbackBody = {
  status: string;
  sampleCount: number;
  performance: {
    medianMfeCaptureRatio: number | null;
    mfeCaptureSamples: number;
  };
  drift: {
    comparisonReady: boolean;
    recentVsPriorMeanNetRDelta: number | null;
  };
  cohorts: {
    executionMode: Array<{ key: string; sampleCount: number }>;
  };
  policy: { automaticSizingChange: boolean; automaticLeverageChange: boolean };
};

type CatalogBody = {
  count: number;
  cases: Array<{
    decisionId: string;
    outcomeFinalized: boolean;
    outcomeSampleCount: number;
  }>;
};

type DecisionQualityBody = {
  finalizedCases: number;
  overall: {
    enterSamples: number;
    enterCorrectRate: number | null;
    medianEnterSignedReturnBps30m: number | null;
    abstainSamples: number;
    medianAbstainOpportunityBps30m: number | null;
  };
  cohorts: { contextPackVersion: Array<{ key: string; totalCases: number }> };
};

function countFor(sql: string): number {
  if (sql.includes('FROM decision_log') && sql.includes('context_pack_version'))
    return 80;
  if (sql.includes('FROM decision_log')) return 100;
  if (sql.includes('FROM replay_cases')) return 75;
  if (sql.includes('FROM replay_case_outcomes')) return 60;
  if (sql.includes('FROM replay_experiments')) return 2;
  if (sql.includes('FROM replay_eval_runs')) return 55;
  if (sql.includes('FROM decision_trade_lineage')) return 25;
  return 0;
}

describe('research feedback loop operations', () => {
  it('reports a pending Phase 25 schema without hiding the rest of readiness inventory', async () => {
    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            first() {
              if (sql.includes('SELECT plan_leverage')) {
                return Promise.reject(new Error('no such column'));
              }
              return Promise.resolve({ value: countFor(sql) });
            },
          };
        },
      },
    } as unknown as Env;

    const response = await handleResearchOpsRequest(
      request('/v1/research/readiness'),
      env,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as ReadinessBody;
    expect(body.schema.performanceResearch).toBe('PENDING_MIGRATION');
    expect(body.schema.requiredMigration).toBe('0011_performance_research.sql');
    expect(body.inventory.decisions).toBe(100);
    expect(body.inventory.closedLinkedTradesWithNetR).toBe(0);
    expect(body.nextActions).toContain('APPLY_PENDING_D1_MIGRATIONS');
  });

  it('summarizes PAPER/LIVE cohorts, MFE capture and recent performance drift without changing live risk', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      decisionId: `decision-${index}`,
      executionMode: index % 2 === 0 ? 'PAPER' : 'LIVE_MANUAL',
      closedAt: 100_000 - index,
      realizedNetR: index < 20 ? 0.4 : 0.1,
      mfeR: 0.8,
      maeR: -0.2,
      entryDriftBps: 1.5,
      planLeverage: index % 2 === 0 ? 10 : 20,
      analysisMode: index % 3 === 0 ? 'VERIFY' : 'FAST',
      confidenceBand: 'MEDIUM',
      contextPackVersion: 'context-v2',
    }));
    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            first() {
              if (sql.includes('SELECT plan_leverage'))
                return Promise.resolve(null);
              return Promise.resolve({ value: 40 });
            },
            all() {
              return Promise.resolve({ success: true, results: rows });
            },
          };
        },
      },
    } as unknown as Env;

    const response = await handleResearchOpsRequest(
      request('/v1/research/feedback'),
      env,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as FeedbackBody;
    expect(body.status).toBe('RESEARCH_READY');
    expect(body.sampleCount).toBe(40);
    expect(body.performance.mfeCaptureSamples).toBe(40);
    expect(body.performance.medianMfeCaptureRatio).toBeCloseTo(0.3125, 8);
    expect(body.drift.comparisonReady).toBe(true);
    expect(body.drift.recentVsPriorMeanNetRDelta).toBeCloseTo(0.3, 8);
    expect(body.cohorts.executionMode).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'PAPER', sampleCount: 20 }),
        expect.objectContaining({ key: 'LIVE_MANUAL', sampleCount: 20 }),
      ]),
    );
    expect(body.policy.automaticSizingChange).toBe(false);
    expect(body.policy.automaticLeverageChange).toBe(false);
  });

  it('lists finalized replay cases without exposing future outcome values', async () => {
    const rows = [
      {
        decisionId: 'd-1',
        snapshotId: 's-1',
        marketGeneratedAt: 1000,
        capturedAt: 1100,
        replayVersion: 'replay-v1',
        payloadSha256: 'abc',
        intent: 'NEW_ENTRY',
        decision: 'WAIT_TRIGGER',
        side: 'LONG',
        analysisMode: 'VERIFY',
        instructionVersion: 'phase23-v1',
        contextPackVersion: 'context-v2',
        confidenceBand: 'MEDIUM',
        fingerprintCompleteness: 0.9,
        finalizedAt: 10_000,
        outcomeSampleCount: 50,
      },
    ];
    let boundValues: unknown[] = [];
    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
      DB: {
        prepare(sql: string) {
          expect(sql).toContain('FROM replay_cases c');
          expect(sql).toContain('o.finalized_at IS NOT NULL');
          return {
            bind(...values: unknown[]) {
              boundValues = values;
              return this;
            },
            all() {
              return Promise.resolve({ success: true, results: rows });
            },
          };
        },
      },
    } as unknown as Env;

    const response = await handleResearchOpsRequest(
      request(
        '/v1/research/cases?finalized=true&decision=WAIT_TRIGGER&contextPackVersion=context-v2&limit=25',
      ),
      env,
    );
    expect(response?.status).toBe(200);
    expect(boundValues).toEqual(['WAIT_TRIGGER', 'context-v2', 25]);
    const body = (await response?.json()) as CatalogBody;
    expect(body.count).toBe(1);
    expect(body.cases[0]).toMatchObject({
      decisionId: 'd-1',
      outcomeFinalized: true,
      outcomeSampleCount: 50,
    });
    expect(body.cases[0]).not.toHaveProperty('returnBps30m');
    expect(body.cases[0]).not.toHaveProperty('maxUpBps30m');
  });

  it('separates ENTER direction quality from WAIT/NO_TRADE missed opportunity', async () => {
    const rows = [
      {
        decisionId: 'enter-long-win',
        marketGeneratedAt: 1000,
        decision: 'ENTER_NOW',
        side: 'LONG',
        analysisMode: 'FAST',
        instructionVersion: 'phase23-v1',
        contextPackVersion: 'context-v2',
        confidenceBand: 'MEDIUM',
        returnBps30m: 20,
        maxUpBps30m: 30,
        maxDownBps30m: -5,
      },
      {
        decisionId: 'enter-short-win',
        marketGeneratedAt: 2000,
        decision: 'ENTER_NOW',
        side: 'SHORT',
        analysisMode: 'FAST',
        instructionVersion: 'phase23-v1',
        contextPackVersion: 'context-v2',
        confidenceBand: 'HIGH',
        returnBps30m: -10,
        maxUpBps30m: 6,
        maxDownBps30m: -18,
      },
      {
        decisionId: 'wait',
        marketGeneratedAt: 3000,
        decision: 'WAIT_TRIGGER',
        side: 'NEUTRAL',
        analysisMode: 'VERIFY',
        instructionVersion: 'phase23-v1',
        contextPackVersion: 'context-v2',
        confidenceBand: 'LOW',
        returnBps30m: 4,
        maxUpBps30m: 40,
        maxDownBps30m: -12,
      },
      {
        decisionId: 'no-trade',
        marketGeneratedAt: 4000,
        decision: 'NO_TRADE',
        side: 'NEUTRAL',
        analysisMode: 'VERIFY',
        instructionVersion: 'phase23-v1',
        contextPackVersion: 'context-v2',
        confidenceBand: 'LOW',
        returnBps30m: -2,
        maxUpBps30m: 10,
        maxDownBps30m: -20,
      },
    ];
    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
      DB: {
        prepare(sql: string) {
          expect(sql).toContain('JOIN replay_case_outcomes');
          return {
            all() {
              return Promise.resolve({ success: true, results: rows });
            },
          };
        },
      },
    } as unknown as Env;

    const response = await handleResearchOpsRequest(
      request('/v1/research/decision-quality'),
      env,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as DecisionQualityBody;
    expect(body.finalizedCases).toBe(4);
    expect(body.overall.enterSamples).toBe(2);
    expect(body.overall.enterCorrectRate).toBe(1);
    expect(body.overall.medianEnterSignedReturnBps30m).toBe(15);
    expect(body.overall.abstainSamples).toBe(2);
    expect(body.overall.medianAbstainOpportunityBps30m).toBe(30);
    expect(body.cohorts.contextPackVersion).toContainEqual(
      expect.objectContaining({ key: 'context-v2', totalCases: 4 }),
    );
  });

  it('rejects invalid replay catalog filters', async () => {
    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
    } as Env;
    const response = await handleResearchOpsRequest(
      request('/v1/research/cases?decision=BUY_NOW'),
      env,
    );
    expect(response?.status).toBe(400);
  });

  it('requires the existing Action bearer for research operations', async () => {
    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
    } as Env;
    const response = await handleResearchOpsRequest(
      request('/v1/research/readiness', false),
      env,
    );
    expect(response?.status).toBe(401);
  });
});
