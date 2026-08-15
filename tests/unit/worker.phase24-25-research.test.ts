import { describe, expect, it } from 'vitest';

import type { Env } from '../../worker/src/index';
import { handleResearchReadRequest } from '../../worker/src/phase24-25-research';

type BenchmarkBody = {
  version: string;
  matchedCases: number;
  agreement: { decisionAgreementRate: number | null };
  promotionEvidence: { status: string };
  actualExecution: { averageRealizedNetR: number | null };
};

type SizingBody = {
  version: string;
  status: string;
  sampleCount: number;
  candidateRiskMultiplier: { multiplier: number } | null;
  liveActivation: { enabled: boolean; requiresExplicitApproval: boolean };
  leverageResearch: { recommendation: unknown };
};

function request(path: string, authorized = true) {
  return new Request(`https://example.com${path}`, {
    headers: authorized ? { authorization: 'Bearer read' } : {},
  });
}

describe('Phase 24-25 research', () => {
  it('benchmarks live Custom GPT against the same replay cases without auto promotion', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      decisionId: `d-${index}`,
      liveDecision: 'ENTER_NOW',
      liveSide: index % 2 === 0 ? 'LONG' : 'SHORT',
      liveAnalysisMode: 'FAST',
      liveConfidenceBand: 'MEDIUM',
      liveLatencyMs: 4_000,
      apiOutputPayload: JSON.stringify({
        outputVersion: 'eval-output-v1',
        decision: 'ENTER_NOW',
        side: index % 2 === 0 ? 'LONG' : 'SHORT',
      }),
      apiLatencyMs: 2_000,
      inputTokens: 1_000,
      outputTokens: 100,
      cachedInputTokens: 0,
      reportedCostUsd: 0.01,
      costBasis: 'REPORTED',
      returnBps30m: index % 4 === 0 ? -5 : 10,
      maxUpBps30m: 20,
      maxDownBps30m: -10,
      realizedNetR: index < 10 ? 0.2 : null,
      tradeClosedAt: index < 10 ? 20_000 + index : null,
    }));
    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
      DB: {
        prepare(sql: string) {
          if (sql.includes('FROM replay_experiments')) {
            return {
              bind() {
                return this;
              },
              first() {
                return Promise.resolve({
                  experimentId: 'api-a',
                  name: 'API A',
                  provider: 'OPENAI',
                  model: 'gpt-test',
                  modelVersion: null,
                  instructionVersion: 'phase23-v1',
                  contextPackVersion: 'context-v2',
                  analysisMode: 'FAST',
                  createdAt: 1_000,
                });
              },
            };
          }
          return {
            bind() {
              return this;
            },
            all() {
              return Promise.resolve({ success: true, results: rows });
            },
          };
        },
      },
    } as unknown as Env;

    const response = await handleResearchReadRequest(
      request('/v1/research/benchmark/api-a'),
      env,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as BenchmarkBody;
    expect(body.version).toBe('benchmark-v1');
    expect(body.matchedCases).toBe(50);
    expect(body.agreement.decisionAgreementRate).toBe(1);
    expect(body.promotionEvidence.status).toBe('READY_FOR_MANUAL_REVIEW');
    expect(body.promotionEvidence).not.toHaveProperty('promote');
    expect(body.actualExecution.averageRealizedNetR).toBeCloseTo(0.2, 8);
  });

  it('keeps sizing performance research disabled for live activation', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      decisionId: `d-${index}`,
      closedAt: 10_000 + index,
      realizedNetR: index % 4 === 0 ? -0.6 : 0.5,
      leverage: index % 2 === 0 ? 10 : 20,
      analysisMode: index % 3 === 0 ? 'VERIFY' : 'FAST',
      confidenceBand: 'MEDIUM',
      contextPackVersion: 'context-v2',
      entryDriftBps: 1,
      mfeR: 0.8,
      maeR: -0.3,
    }));
    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            all() {
              return Promise.resolve({ success: true, results: rows });
            },
          };
        },
      },
    } as unknown as Env;

    const response = await handleResearchReadRequest(
      request('/v1/research/performance-sizing'),
      env,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as SizingBody;
    expect(body.version).toBe('sizing-research-v1');
    expect(body.status).toBe('RESEARCH_ONLY');
    expect(body.sampleCount).toBe(40);
    expect(body.candidateRiskMultiplier?.multiplier ?? 99).toBeLessThanOrEqual(1.2);
    expect(body.liveActivation.enabled).toBe(false);
    expect(body.liveActivation.requiresExplicitApproval).toBe(true);
    expect(body.leverageResearch.recommendation).toBeNull();
  });

  it('requires Action bearer auth for research reads', async () => {
    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
    } as Env;
    const response = await handleResearchReadRequest(
      request('/v1/research/performance-sizing', false),
      env,
    );
    expect(response?.status).toBe(401);
  });
});
