import { describe, expect, it } from 'vitest';

import type { Env } from '../../worker/src/index';
import { handleResearchDecisionCohortsRequest } from '../../worker/src/research-decision-cohorts-route';

function request(path: string, authorized = true) {
  return new Request(`https://example.com${path}`, {
    headers: authorized ? { authorization: 'Bearer read' } : {},
  });
}

function snapshot() {
  return JSON.stringify({
    version: 'decision-context-v1',
    completeness: {
      cryptoMarketAvailable: true,
      leadAssetsAvailable: 2,
      dynamicAssetCount: 4,
      crossMarket: 1,
      externalAvailable: true,
    },
    btcCore: {
      timeframes: {
        '15m': { realizedVolatility: 12 },
        '1h': { return12: 3 },
      },
    },
  });
}

function score() {
  return JSON.stringify({
    evaluatorVersion: 'eval-v2',
    decisionClass: 'ENTER',
    decisionEvaluation: {
      available: true,
      mfeR: 1.2,
      maeR: 0.5,
      targets: [{ orderingVsStop: 'TARGET_FIRST' }],
    },
  });
}

describe('research decision cohort route', () => {
  it('returns read-only cohort analysis for an existing experiment', async () => {
    const env = {
      ACTION_READ_KEY: 'read',
      DB: {
        prepare(sql: string) {
          if (sql.includes('FROM replay_experiments')) {
            return {
              bind() {
                return this;
              },
              first() {
                return Promise.resolve({ experimentId: 'exp-a' });
              },
            };
          }
          expect(sql).toContain('LEFT JOIN replay_cases');
          return {
            bind() {
              return this;
            },
            all() {
              return Promise.resolve({
                success: true,
                results: [
                  {
                    decisionId: 'd-1',
                    scorePayload: score(),
                    snapshotPayload: snapshot(),
                  },
                ],
              });
            },
          };
        },
      },
    } as unknown as Env;

    const response = await handleResearchDecisionCohortsRequest(
      request('/v1/research/decision-cohorts/exp-a'),
      env,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      experimentId: string;
      version: string;
      decisionMix: { counts: { ENTER: number } };
      policy: { automaticPromotion: boolean };
    };
    expect(body.experimentId).toBe('exp-a');
    expect(body.version).toBe('research-decision-cohorts-v1');
    expect(body.decisionMix.counts.ENTER).toBe(1);
    expect(body.policy.automaticPromotion).toBe(false);
  });

  it('requires Action bearer auth', async () => {
    const env = { ACTION_READ_KEY: 'read' } as Env;
    const response = await handleResearchDecisionCohortsRequest(
      request('/v1/research/decision-cohorts/exp-a', false),
      env,
    );
    expect(response?.status).toBe(401);
  });

  it('returns 404 when the experiment does not exist', async () => {
    const env = {
      ACTION_READ_KEY: 'read',
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            first() {
              return Promise.resolve(null);
            },
          };
        },
      },
    } as unknown as Env;
    const response = await handleResearchDecisionCohortsRequest(
      request('/v1/research/decision-cohorts/missing'),
      env,
    );
    expect(response?.status).toBe(404);
  });
});
