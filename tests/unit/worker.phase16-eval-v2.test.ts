import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../worker/src/index';
import { handler } from '../../worker/src/phase16b';

type SqliteInput = string | number | bigint | Uint8Array | null;

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string) {
    const prepared = this.database.prepare(query);
    let values: unknown[] = [];
    const statement = {
      bind: (...nextValues: unknown[]) => {
        values = nextValues;
        return statement;
      },
      run: () => {
        prepared.run(...(values as SqliteInput[]));
        return Promise.resolve({ success: true });
      },
      first: <T>(): Promise<T | null> => {
        const row = prepared.get(...(values as SqliteInput[])) as T | undefined;
        return Promise.resolve(row ?? null);
      },
    };
    return statement;
  }
}

function request(path: string, method = 'GET', body?: unknown) {
  return new Request(`https://example.com${path}`, {
    method,
    headers: {
      authorization: 'Bearer read-secret',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function v2Experiment() {
  return {
    experimentId: 'exp-v2',
    name: 'Evaluation V2',
    replayVersion: 'replay-v1',
    evaluatorVersion: 'eval-v2',
    provider: 'MANUAL',
    model: 'candidate-manual',
    modelVersion: '1',
    instructionVersion: 'decision-context-v1',
    contextPackVersion: 'decision-context-v1',
    analysisMode: 'VERIFY',
    enabledSources: ['BINANCE', 'CRYPTO_MARKET_V2'],
  };
}

function enterOutput() {
  return {
    outputVersion: 'eval-output-v2',
    decision: 'ENTER_NOW',
    side: 'LONG',
    confidenceBand: 'MEDIUM',
    planValidation: 'VALIDATED',
    entry: 100,
    stop: 99,
    targets: [101.5, 102],
    triggerSummary: null,
    triggerContract: null,
    invalidationSummary: 'below 99',
    reasonTags: ['STRUCTURE'],
    counterThesisTags: ['OI_DIVERGENCE'],
    providerResponseId: 'candidate-enter',
    latencyMs: 900,
    usage: {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reportedCostUsd: null,
      costBasis: 'UNKNOWN',
    },
  };
}

describe('Evaluation V2 experiment scoring', () => {
  let database: DatabaseSync;
  let env: Env;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE decision_log (decision_id TEXT PRIMARY KEY);
    `);
    database.exec(
      readFileSync('worker/migrations/0008_replay_eval_lab.sql', 'utf8'),
    );
    database.exec(
      readFileSync('worker/migrations/0012_evaluation_v2.sql', 'utf8'),
    );
    database.exec(
      readFileSync(
        'worker/migrations/0009_replay_experiment_registry.sql',
        'utf8',
      ),
    );
    env = {
      DB: new SqliteD1(database),
      UPLOADER_WRITE_KEY: 'upload-secret',
      ACTION_READ_KEY: 'read-secret',
    };
  });

  afterEach(() => database.close());

  function seed(decisionId: string, pricePath: Array<[number, number]>) {
    database
      .prepare('INSERT INTO decision_log (decision_id) VALUES (?)')
      .run(decisionId);
    database
      .prepare(
        `INSERT INTO replay_cases (
          decision_id, snapshot_id, market_generated_at, replay_version,
          source_lease_at, captured_at, anchor_mark_price, payload_bytes,
          payload_sha256, snapshot_payload
        ) VALUES (?, ?, 1000000, 'replay-v1', 1000100, 1000200, 100, 1000, ?, ?)`,
      )
      .run(
        decisionId,
        `snapshot-${decisionId}`,
        `hash-${decisionId}`,
        JSON.stringify({ snapshotId: `snapshot-${decisionId}` }),
      );
    database
      .prepare(
        `INSERT INTO replay_case_outcomes (
          decision_id, market_generated_at, anchor_mark_price,
          max_up_bps_1m, max_down_bps_1m, return_bps_1m,
          max_up_bps_3m, max_down_bps_3m, return_bps_3m,
          max_up_bps_5m, max_down_bps_5m, return_bps_5m,
          max_up_bps_15m, max_down_bps_15m, return_bps_15m,
          max_up_bps_30m, max_down_bps_30m, return_bps_30m,
          max_up_bps_60m, max_down_bps_60m, return_bps_60m,
          price_path_version, price_path_json, last_path_observed_at, finalized_at
        ) VALUES (?, 1000000, 100,
          160, -120, 80, 200, -140, 120, 250, -150, 150,
          300, -180, 180, 350, -200, 200, 400, -250, 250,
          'path-v1', ?, 4600000, 4600000)`,
      )
      .run(decisionId, JSON.stringify(pricePath));
  }

  async function register() {
    return handler(
      request('/v1/replay/experiment/register', 'POST', v2Experiment()),
      env,
    );
  }

  async function start(runId: string, decisionId: string, trialIndex: number) {
    return handler(
      request('/v1/replay/run/start', 'POST', {
        runId,
        experimentId: 'exp-v2',
        decisionId,
        trialIndex,
      }),
      env,
    );
  }

  it('scores ENTER_NOW with six horizons and plan-aware path quality', async () => {
    seed('decision-enter-v2', [
      [10_000, 100.2],
      [30_000, 101.6],
      [60_000, 102.2],
      [90_000, 98.8],
      [180_000, 103],
    ]);
    expect((await register()).status).toBe(201);
    expect((await start('run-enter-v2', 'decision-enter-v2', 1)).status).toBe(
      201,
    );

    const response = await handler(
      request('/v1/replay/run/run-enter-v2/output', 'POST', enterOutput()),
      env,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      score: {
        evaluatorVersion: string;
        horizons: Record<string, unknown>;
        decisionEvaluation: {
          available: boolean;
          mfeR: number;
          maeR: number;
          stopHitMs: number;
          targets: Array<{ orderingVsStop: string }>;
        };
        notes: string[];
      };
    };
    expect(body.score.evaluatorVersion).toBe('eval-v2');
    expect(Object.keys(body.score.horizons)).toEqual([
      '1m',
      '3m',
      '5m',
      '15m',
      '30m',
      '60m',
    ]);
    expect(body.score.decisionEvaluation.available).toBe(true);
    expect(body.score.decisionEvaluation.mfeR).toBeGreaterThan(2);
    expect(body.score.decisionEvaluation.maeR).toBeGreaterThan(1);
    expect(body.score.decisionEvaluation.stopHitMs).toBe(90_000);
    expect(
      body.score.decisionEvaluation.targets[0]?.orderingVsStop,
    ).toBe('TARGET_FIRST');
    expect(body.score.notes.join(' ')).toContain('No scalar strategy score');
  });

  it('requires a structured WAIT contract and evaluates trigger mechanics without a scalar penalty', async () => {
    seed('decision-wait-v2', [
      [5_000, 100.5],
      [10_000, 101],
      [20_000, 101.2],
      [40_000, 102],
      [80_000, 100.8],
    ]);
    expect((await register()).status).toBe(201);
    expect((await start('run-wait-v2', 'decision-wait-v2', 1)).status).toBe(
      201,
    );

    const missingContract = await handler(
      request('/v1/replay/run/run-wait-v2/output', 'POST', {
        ...enterOutput(),
        decision: 'WAIT_TRIGGER',
        side: 'LONG',
        planValidation: 'NOT_APPLICABLE',
        entry: null,
        stop: null,
        targets: [],
        triggerContract: null,
        providerResponseId: 'candidate-wait-missing',
      }),
      env,
    );
    expect(missingContract.status).toBe(400);

    const triggerContract = {
      authoredBy: 'GPT',
      triggerId: 'trigger-wait-v2',
      decisionId: 'candidate-decision-wait-v2',
      sourceSnapshotId: 'snapshot-decision-wait-v2',
      triggerType: 'BREAKOUT_CONFIRM',
      referencePrice: 'MARK_PRICE',
      triggerCondition: 'AT_OR_ABOVE',
      triggerPrice: 101,
      confirmWindowSec: 5,
      invalidationCondition: 'AT_OR_BELOW',
      invalidationPrice: 98,
      expiresAt: 1_120_000,
      maxChaseBps: 25,
    };
    const scored = await handler(
      request('/v1/replay/run/run-wait-v2/output', 'POST', {
        ...enterOutput(),
        decision: 'WAIT_TRIGGER',
        side: 'LONG',
        planValidation: 'NOT_APPLICABLE',
        entry: null,
        stop: null,
        targets: [],
        triggerSummary: 'breakout confirm',
        triggerContract,
        providerResponseId: 'candidate-wait',
      }),
      env,
    );
    expect(scored.status).toBe(201);
    const body = (await scored.json()) as {
      score: {
        decisionEvaluation: {
          available: boolean;
          triggerHit: boolean;
          timeToTriggerMs: number | null;
          maxChaseExceededAtTrigger: boolean | null;
          notes: string[];
        };
      };
    };
    expect(body.score.decisionEvaluation).toMatchObject({
      available: true,
      triggerHit: true,
      timeToTriggerMs: 20_000,
      maxChaseExceededAtTrigger: false,
    });
    expect(body.score.decisionEvaluation.notes.join(' ')).toContain(
      'No directional score',
    );
  });
});
