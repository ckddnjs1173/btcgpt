import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../worker/src/index';
import {
  attachReplayCaseToDecision,
  handleReplayReadRequest,
  saveReplaySnapshotLease,
  updateReplayOutcomesFromSnapshot,
} from '../../worker/src/phase16-replay';

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

function snapshot(snapshotId: string, generatedAt: number, markPrice: number) {
  return {
    schemaVersion: 5,
    snapshotId,
    symbol: 'BTCUSDT',
    market: 'BINANCE_USDM_PERPETUAL',
    generatedAt,
    marketState: { markPrice },
    analysisGate: {
      analysisAllowed: true,
      overallStatus: 'NORMAL',
      ageMs: 1_000,
      publishedAt: generatedAt + 100,
    },
    decisionGates: {
      marketAnalysisAvailable: true,
      entryAllowed: true,
      positionManagementAvailable: true,
      quality: 'GREEN',
      generatedAt,
      publishedAt: generatedAt + 100,
      ageMs: 1_000,
      criticalBlockers: [],
      degradedSources: [],
      missingFields: [],
    },
    riskContext: {
      status: 'NORMAL',
      highRiskNews: false,
      sourceWarnings: [],
    },
  };
}

function authRequest(path: string, authenticated = true) {
  return new Request(`https://example.com${path}`, {
    headers: authenticated
      ? { authorization: 'Bearer read-secret' }
      : undefined,
  });
}

describe('phase 16 replay/eval foundation', () => {
  let database: DatabaseSync;
  let env: Env;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE decision_log (
        decision_id TEXT PRIMARY KEY,
        recorded_at INTEGER NOT NULL,
        intent TEXT NOT NULL,
        decision TEXT NOT NULL,
        side TEXT NOT NULL,
        analysis_mode TEXT NOT NULL,
        confidence_band TEXT NOT NULL,
        plan_validation TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE decision_market_fingerprint (
        decision_id TEXT PRIMARY KEY,
        fingerprint_version TEXT NOT NULL,
        completeness REAL NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE decision_trade_lineage (
        decision_id TEXT PRIMARY KEY,
        plan_id TEXT,
        mode TEXT,
        trade_id TEXT,
        trade_status TEXT,
        realized_net_pnl REAL,
        decision_to_plan_lock_ms INTEGER,
        trigger_to_trade_open_ms INTEGER,
        entry_timing_quality TEXT,
        planned_entry REAL,
        actual_entry REAL,
        entry_drift_bps REAL,
        initial_risk_usdt REAL,
        mfe_bps REAL,
        mae_bps REAL,
        mfe_r REAL,
        mae_r REAL,
        realized_net_r REAL,
        holding_time_ms INTEGER,
        cost_basis TEXT
      );
    `);
    database.exec(
      readFileSync('worker/migrations/0008_replay_eval_lab.sql', 'utf8'),
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

  it('leases an exact GPT snapshot and promotes it to an immutable replay input', async () => {
    const marketGeneratedAt = 1_000_000;
    const decisionId = 'decision-replay-a';
    database
      .prepare(
        `INSERT INTO decision_log (
          decision_id, recorded_at, intent, decision, side, analysis_mode,
          confidence_band, plan_validation, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decisionId,
        marketGeneratedAt + 2_000,
        'NEW_ENTRY',
        'WAIT_TRIGGER',
        'LONG',
        'FAST',
        'MEDIUM',
        'NOT_APPLICABLE',
        JSON.stringify({ reasonTags: ['STRUCTURE'] }),
      );

    const leased = await saveReplaySnapshotLease(
      env,
      snapshot('snapshot-replay-a', marketGeneratedAt, 100),
      marketGeneratedAt + 1_000,
    );
    expect(leased).toBe(true);

    const captured = await attachReplayCaseToDecision(env, {
      decisionId,
      snapshotId: 'snapshot-replay-a',
      marketGeneratedAt,
      capturedAt: marketGeneratedAt + 2_000,
    });
    expect(captured).toBe(true);

    const inputResponse = await handleReplayReadRequest(
      authRequest(`/v1/replay/case/${decisionId}/input`),
      env,
    );
    expect(inputResponse?.status).toBe(200);
    const input = (await inputResponse?.json()) as Record<string, unknown>;
    expect(input).toMatchObject({
      decisionId,
      replayVersion: 'replay-v1',
      snapshotId: 'snapshot-replay-a',
      marketGeneratedAt,
      anchorMarkPrice: 100,
    });
    expect(String(input.payloadSha256)).toHaveLength(64);
    expect(input).not.toHaveProperty('originalDecision');
    expect(input).not.toHaveProperty('futurePath');
    expect(input.snapshot).toMatchObject({
      snapshotId: 'snapshot-replay-a',
      marketState: { markPrice: 100 },
    });

    await saveReplaySnapshotLease(
      env,
      snapshot('snapshot-replay-a', marketGeneratedAt, 999),
      marketGeneratedAt + 3_000,
    );
    const recaptured = await attachReplayCaseToDecision(env, {
      decisionId,
      snapshotId: 'snapshot-replay-a',
      marketGeneratedAt,
      capturedAt: marketGeneratedAt + 4_000,
    });
    expect(recaptured).toBe(true);

    const immutable = database
      .prepare(
        'SELECT anchor_mark_price AS anchorMarkPrice FROM replay_cases WHERE decision_id = ?',
      )
      .get(decisionId) as { anchorMarkPrice: number };
    expect(immutable.anchorMarkPrice).toBe(100);
  });

  it('keeps future outcome labels separate and relay-samples 5/15/30/60 minute paths', async () => {
    const marketGeneratedAt = 2_000_000;
    const decisionId = 'decision-outcome-a';
    database
      .prepare(
        `INSERT INTO decision_log (
          decision_id, recorded_at, intent, decision, side, analysis_mode,
          confidence_band, plan_validation, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decisionId,
        marketGeneratedAt + 2_000,
        'MARKET_ANALYSIS',
        'NO_TRADE',
        'NEUTRAL',
        'FAST',
        'LOW',
        'NOT_APPLICABLE',
        JSON.stringify({ reasonTags: ['NO_EDGE'] }),
      );

    await saveReplaySnapshotLease(
      env,
      snapshot('snapshot-outcome-a', marketGeneratedAt, 100),
      marketGeneratedAt + 1_000,
    );
    expect(
      await attachReplayCaseToDecision(env, {
        decisionId,
        snapshotId: 'snapshot-outcome-a',
        marketGeneratedAt,
      }),
    ).toBe(true);

    await updateReplayOutcomesFromSnapshot(
      env,
      snapshot('future-4m', marketGeneratedAt + 4 * 60_000, 102),
    );
    await updateReplayOutcomesFromSnapshot(
      env,
      snapshot('future-6m', marketGeneratedAt + 6 * 60_000, 101),
    );
    await updateReplayOutcomesFromSnapshot(
      env,
      snapshot('future-16m', marketGeneratedAt + 16 * 60_000, 98),
    );
    await updateReplayOutcomesFromSnapshot(
      env,
      snapshot('future-31m', marketGeneratedAt + 31 * 60_000, 103),
    );
    await updateReplayOutcomesFromSnapshot(
      env,
      snapshot('future-61m', marketGeneratedAt + 61 * 60_000, 104),
    );

    const outcomeResponse = await handleReplayReadRequest(
      authRequest(`/v1/replay/case/${decisionId}/outcome`),
      env,
    );
    expect(outcomeResponse?.status).toBe(200);
    const body = (await outcomeResponse?.json()) as {
      futurePath: Record<string, number | null>;
      originalDecision: Record<string, unknown>;
      samplingBasis: string;
    };
    expect(body.originalDecision).toMatchObject({
      decision: 'NO_TRADE',
      side: 'NEUTRAL',
    });
    expect(body.samplingBasis).toBe('RELAY_MARK_PRICE');
    expect(body.futurePath.sampleCount).toBe(5);
    expect(body.futurePath.maxUpBps5m).toBeCloseTo(200, 8);
    expect(body.futurePath.returnBps5m).toBeCloseTo(100, 8);
    expect(body.futurePath.maxDownBps15m).toBeCloseTo(100, 8);
    expect(body.futurePath.returnBps15m).toBeCloseTo(-200, 8);
    expect(body.futurePath.maxDownBps30m).toBeCloseTo(-200, 8);
    expect(body.futurePath.returnBps30m).toBeCloseTo(300, 8);
    expect(body.futurePath.returnBps60m).toBeCloseTo(400, 8);
    expect(body.futurePath.finalizedAt).toBe(marketGeneratedAt + 61 * 60_000);
  });

  it('protects research replay reads with the Action credential', async () => {
    const response = await handleReplayReadRequest(
      authRequest('/v1/replay/case/decision-a/input', false),
      env,
    );
    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });
});
