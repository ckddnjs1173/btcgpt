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

function request(
  path: string,
  options: { method?: string; body?: unknown; authenticated?: boolean } = {},
) {
  const { method = 'GET', body, authenticated = true } = options;
  return new Request(`https://example.com${path}`, {
    method,
    headers: authenticated
      ? {
          authorization: 'Bearer read-secret',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        }
      : body === undefined
        ? undefined
        : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function experiment(overrides: Record<string, unknown> = {}) {
  return {
    experimentId: 'exp-a',
    name: 'Baseline replay',
    replayVersion: 'replay-v1',
    evaluatorVersion: 'eval-v1',
    provider: 'MANUAL',
    model: 'baseline-manual',
    modelVersion: '1',
    instructionVersion: 'phase13-v1',
    contextPackVersion: 'snapshot-schema-v5',
    analysisMode: 'FAST',
    enabledSources: ['BINANCE', 'RISK_CONTEXT'],
    ...overrides,
  };
}

function output(overrides: Record<string, unknown> = {}) {
  return {
    outputVersion: 'eval-output-v1',
    decision: 'ENTER_NOW',
    side: 'LONG',
    confidenceBand: 'HIGH',
    planValidation: 'VALIDATED',
    entry: 100,
    stop: 99,
    targets: [102],
    triggerSummary: null,
    invalidationSummary: 'below stop',
    reasonTags: ['STRUCTURE'],
    counterThesisTags: ['OI_DIVERGENCE'],
    providerResponseId: 'manual-a',
    latencyMs: 1200,
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 100,
      reportedCostUsd: 0.03,
      costBasis: 'REPORTED',
    },
    ...overrides,
  };
}

describe('phase 16B replay experiment registry', () => {
  let database: DatabaseSync;
  let env: Env;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE decision_log (
        decision_id TEXT PRIMARY KEY
      );
    `);
    database.exec(
      readFileSync('worker/migrations/0008_replay_eval_lab.sql', 'utf8'),
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

  afterEach(() => {
    database.close();
  });

  function seedReplayCase(
    decisionId: string,
    options: { finalized?: boolean } = {},
  ) {
    const { finalized = true } = options;
    database
      .prepare('INSERT INTO decision_log (decision_id) VALUES (?)')
      .run(decisionId);
    database
      .prepare(
        `INSERT INTO replay_cases (
          decision_id, snapshot_id, market_generated_at, replay_version,
          source_lease_at, captured_at, anchor_mark_price, payload_bytes,
          payload_sha256, snapshot_payload
        ) VALUES (?, ?, ?, 'replay-v1', ?, ?, 100, 1000, ?, ?)`,
      )
      .run(
        decisionId,
        `snapshot-${decisionId}`,
        1_000_000,
        1_000_100,
        1_000_200,
        `hash-${decisionId}`,
        JSON.stringify({ snapshotId: `snapshot-${decisionId}` }),
      );
    database
      .prepare(
        `INSERT INTO replay_case_outcomes (
          decision_id, market_generated_at, anchor_mark_price,
          max_up_bps_5m, max_down_bps_5m, return_bps_5m,
          max_up_bps_15m, max_down_bps_15m, return_bps_15m,
          max_up_bps_30m, max_down_bps_30m, return_bps_30m,
          max_up_bps_60m, max_down_bps_60m, return_bps_60m,
          finalized_at
        ) VALUES (?, 1000000, 100, 100, -50, 60, 150, -80, -20,
          300, -200, 100, 400, -250, 150, ?)`,
      )
      .run(decisionId, finalized ? 4_700_000 : null);
  }

  async function register(body: Record<string, unknown> = experiment()) {
    return handler(
      request('/v1/replay/experiment/register', {
        method: 'POST',
        body,
      }),
      env,
    );
  }

  async function startRun(runId: string, decisionId: string, trialIndex = 1) {
    return handler(
      request('/v1/replay/run/start', {
        method: 'POST',
        body: {
          runId,
          experimentId: 'exp-a',
          decisionId,
          trialIndex,
        },
      }),
      env,
    );
  }

  it('registers immutable experiment configs with idempotent retries', async () => {
    const unauthorized = await handler(
      request('/v1/replay/experiment/register', {
        method: 'POST',
        body: experiment(),
        authenticated: false,
      }),
      env,
    );
    expect(unauthorized.status).toBe(401);

    const created = await register();
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody).toMatchObject({
      ok: true,
      experimentId: 'exp-a',
      duplicate: false,
    });
    expect(String(createdBody.configSha256)).toHaveLength(64);

    const duplicate = await register();
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });

    const conflict = await register(experiment({ model: 'changed-model' }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: 'EXPERIMENT_ID_CONFLICT',
    });
  });

  it('starts only finalized replay cases and locks one run per trial', async () => {
    expect((await register()).status).toBe(201);
    seedReplayCase('decision-pending', { finalized: false });
    const pending = await startRun('run-pending', 'decision-pending');
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({
      error: 'REPLAY_OUTCOME_NOT_FINALIZED',
    });

    seedReplayCase('decision-final');
    const created = await startRun('run-a', 'decision-final');
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      ok: true,
      runId: 'run-a',
      duplicate: false,
      status: 'PENDING',
    });

    const duplicate = await startRun('run-a', 'decision-final');
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });

    const competing = await startRun('run-b', 'decision-final');
    expect(competing.status).toBe(409);
    expect(await competing.json()).toMatchObject({
      error: 'EXPERIMENT_TRIAL_ALREADY_EXISTS',
      runId: 'run-a',
    });
  });

  it('freezes structured output before deterministic future-outcome scoring', async () => {
    expect((await register()).status).toBe(201);
    seedReplayCase('decision-long');
    expect((await startRun('run-long', 'decision-long')).status).toBe(201);

    const scored = await handler(
      request('/v1/replay/run/run-long/output', {
        method: 'POST',
        body: output(),
      }),
      env,
    );
    expect(scored.status).toBe(201);
    const scoredBody = (await scored.json()) as {
      score: {
        evaluatorVersion: string;
        scoreStatus: string;
        horizons: Record<
          string,
          {
            signedReturnBps: number | null;
            favorableBps: number | null;
            adverseBps: number | null;
            directionCorrect: boolean | null;
          }
        >;
      };
    };
    expect(scoredBody.score).toMatchObject({
      evaluatorVersion: 'eval-v1',
      scoreStatus: 'FINAL',
    });
    expect(scoredBody.score.horizons['30m']).toMatchObject({
      signedReturnBps: 100,
      favorableBps: 300,
      adverseBps: 200,
      directionCorrect: true,
    });

    const duplicate = await handler(
      request('/v1/replay/run/run-long/output', {
        method: 'POST',
        body: output(),
      }),
      env,
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });

    const conflict = await handler(
      request('/v1/replay/run/run-long/output', {
        method: 'POST',
        body: output({ side: 'SHORT' }),
      }),
      env,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: 'RUN_OUTPUT_CONFLICT',
    });

    const run = await handler(request('/v1/replay/run/run-long'), env);
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({
      runId: 'run-long',
      status: 'SCORED',
      scoreStatus: 'FINAL',
      usage: {
        latencyMs: 1200,
        reportedCostUsd: 0.03,
        costBasis: 'REPORTED',
      },
    });
  });

  it('keeps abstention opportunity separate from directional accuracy in summaries', async () => {
    expect((await register()).status).toBe(201);
    seedReplayCase('decision-long');
    seedReplayCase('decision-abstain');
    expect((await startRun('run-long', 'decision-long')).status).toBe(201);
    expect((await startRun('run-abstain', 'decision-abstain')).status).toBe(
      201,
    );

    expect(
      (
        await handler(
          request('/v1/replay/run/run-long/output', {
            method: 'POST',
            body: output(),
          }),
          env,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await handler(
          request('/v1/replay/run/run-abstain/output', {
            method: 'POST',
            body: output({
              decision: 'NO_TRADE',
              side: 'NEUTRAL',
              planValidation: 'NOT_APPLICABLE',
              entry: null,
              stop: null,
              targets: [],
              providerResponseId: 'manual-b',
              latencyMs: 800,
              usage: {
                inputTokens: null,
                outputTokens: null,
                cachedInputTokens: null,
                reportedCostUsd: null,
                costBasis: 'UNKNOWN',
              },
            }),
          }),
          env,
        )
      ).status,
    ).toBe(201);

    const summary = await handler(
      request('/v1/replay/experiment/exp-a/summary'),
      env,
    );
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      experimentId: 'exp-a',
      totalRuns: 2,
      outputRecordedRuns: 2,
      finalScoredRuns: 2,
      directional30m: {
        samples: 1,
        correct: 1,
        accuracy: 1,
        avgSignedReturnBps: 100,
      },
      abstain30m: {
        samples: 1,
        avgOpportunityBps: 300,
      },
      efficiency: {
        avgLatencyMs: 1000,
        reportedCostSamples: 1,
        totalReportedCostUsd: 0.03,
      },
    });
  });
});
