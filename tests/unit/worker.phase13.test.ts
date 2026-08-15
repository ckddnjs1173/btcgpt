import { beforeEach, describe, expect, it } from 'vitest';

import { handler } from '../../worker/src/phase13';
import type { Env } from '../../worker/src/index';

type SnapshotRow = {
  raw: string;
  generatedAt: number;
  receivedAt: number;
};

type DecisionRow = {
  snapshotId: string;
  recordedAt: number;
  snapshotStatus: 'CURRENT' | 'SUPERSEDED';
  snapshotToRecordLatencyMs: number;
  payload: string;
};

class MemoryD1 {
  private snapshot: SnapshotRow | null = null;
  private readonly decisions = new Map<string, DecisionRow>();

  prepare(query: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...nextValues: unknown[]) => {
        values = nextValues;
        return statement;
      },
      run: () => {
        if (query.includes('INSERT INTO latest_snapshot')) {
          const [raw, generatedAt, receivedAt] = values as [
            string,
            number,
            number,
          ];
          if (!this.snapshot || generatedAt >= this.snapshot.generatedAt) {
            this.snapshot = { raw, generatedAt, receivedAt };
          }
        } else if (query.includes('INSERT INTO decision_log')) {
          const [
            decisionId,
            snapshotId,
            ,
            recordedAt,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            snapshotStatus,
            snapshotToRecordLatencyMs,
            ,
            ,
            ,
            ,
            payload,
          ] = values as [
            string,
            string,
            number,
            number,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string | null,
            'CURRENT' | 'SUPERSEDED',
            number,
            string,
            number | null,
            number | null,
            string,
            string,
          ];
          this.decisions.set(decisionId, {
            snapshotId,
            recordedAt,
            snapshotStatus,
            snapshotToRecordLatencyMs,
            payload,
          });
        }
        return Promise.resolve({ success: true });
      },
      first: <T>(): Promise<T | null> => {
        if (query.includes('FROM latest_snapshot')) {
          return Promise.resolve(this.snapshot as T | null);
        }
        if (query.includes('FROM decision_log')) {
          const decision = this.decisions.get(String(values[0])) ?? null;
          return Promise.resolve(decision as T | null);
        }
        return Promise.resolve(null);
      },
    };
    return statement;
  }
}

function snapshotFixture(snapshotId = 'snapshot-a', generatedAt = Date.now()) {
  return {
    schemaVersion: 5,
    appVersion: '0.5.6',
    snapshotId,
    symbol: 'BTCUSDT',
    market: 'BINANCE_USDM_PERPETUAL',
    generatedAt,
    analysisGate: {
      analysisAllowed: true,
      overallStatus: 'NORMAL',
    },
    decisionGates: {
      marketAnalysisAvailable: true,
      entryAllowed: true,
      positionManagementAvailable: true,
      quality: 'GREEN',
      generatedAt,
      publishedAt: null,
      ageMs: 0,
      marketDataAgeMs: 0,
      relayPublishAgeMs: null,
      criticalBlockers: [],
      degradedSources: [],
      missingFields: [],
    },
    scalpContext: {},
    timeframes: { '1m': {} },
  };
}

function decisionFixture(overrides: Record<string, unknown> = {}) {
  return {
    decisionId: 'decision-a',
    snapshotId: 'snapshot-a',
    marketGeneratedAt: 1,
    parentDecisionId: null,
    intent: 'NEW_ENTRY',
    decision: 'WAIT_TRIGGER',
    side: 'LONG',
    analysisMode: 'FAST',
    instructionVersion: 'phase13-v1',
    contextPackVersion: 'snapshot-schema-v5',
    confidenceBand: 'LOW',
    planValidation: 'NOT_APPLICABLE',
    entry: null,
    stop: null,
    targets: [],
    triggerSummary: '1m close above resistance with buy delta confirmation',
    invalidationSummary: 'mark price below local support',
    reasonTags: ['PRICE_STRUCTURE'],
    counterThesisTags: ['CVD_DIVERGENCE'],
    ...overrides,
  };
}

async function uploadSnapshot(
  env: Env,
  snapshot: ReturnType<typeof snapshotFixture>,
) {
  return handler(
    new Request('https://example.com/v1/snapshot/latest', {
      method: 'PUT',
      headers: { authorization: 'Bearer upload-secret' },
      body: JSON.stringify(snapshot),
    }),
    env,
  );
}

async function record(
  env: Env,
  body: Record<string, unknown>,
  authenticated = true,
) {
  return handler(
    new Request('https://example.com/v1/decision/record', {
      method: 'POST',
      headers: authenticated
        ? { authorization: 'Bearer read-secret' }
        : undefined,
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe('phase 13 decision telemetry', () => {
  let env: Env;

  beforeEach(() => {
    env = {
      DB: new MemoryD1(),
      UPLOADER_WRITE_KEY: 'upload-secret',
      ACTION_READ_KEY: 'read-secret',
    };
  });

  it('requires the Action read credential', async () => {
    const response = await record(env, decisionFixture(), false);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('stores a current decision and makes identical retries idempotent', async () => {
    const generatedAt = Date.now();
    const upload = await uploadSnapshot(
      env,
      snapshotFixture('snapshot-a', generatedAt),
    );
    expect(upload.status).toBe(200);

    const body = decisionFixture({ marketGeneratedAt: generatedAt });
    const created = await record(env, body);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      ok: true,
      decisionId: 'decision-a',
      duplicate: false,
      snapshotStatus: 'CURRENT',
    });

    const duplicate = await record(env, body);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      ok: true,
      decisionId: 'decision-a',
      duplicate: true,
      snapshotStatus: 'CURRENT',
    });
  });

  it('rejects conflicting reuse of decisionId', async () => {
    const generatedAt = Date.now();
    await uploadSnapshot(env, snapshotFixture('snapshot-a', generatedAt));
    const body = decisionFixture({ marketGeneratedAt: generatedAt });
    expect((await record(env, body)).status).toBe(201);

    const conflicting = await record(env, {
      ...body,
      decision: 'NO_TRADE',
      side: 'NEUTRAL',
    });
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toMatchObject({
      error: 'DECISION_ID_CONFLICT',
    });
  });

  it('preserves a valid analyzed decision when the relay snapshot has advanced', async () => {
    const olderGeneratedAt = Date.now() - 1_000;
    await uploadSnapshot(env, snapshotFixture('snapshot-a', olderGeneratedAt));
    await uploadSnapshot(env, snapshotFixture('snapshot-b', Date.now()));

    const response = await record(
      env,
      decisionFixture({ marketGeneratedAt: olderGeneratedAt }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true,
      snapshotStatus: 'SUPERSEDED',
    });
  });

  it('requires full validated trade values for ENTER_NOW telemetry', async () => {
    const generatedAt = Date.now();
    await uploadSnapshot(env, snapshotFixture('snapshot-a', generatedAt));

    const invalid = await record(
      env,
      decisionFixture({
        marketGeneratedAt: generatedAt,
        decision: 'ENTER_NOW',
        confidenceBand: 'HIGH',
        planValidation: 'VALIDATED',
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'INVALID_DECISION' });

    const valid = await record(
      env,
      decisionFixture({
        decisionId: 'decision-enter',
        marketGeneratedAt: generatedAt,
        decision: 'ENTER_NOW',
        confidenceBand: 'HIGH',
        planValidation: 'VALIDATED',
        entry: 60_000,
        stop: 59_500,
        targets: [61_000],
      }),
    );
    expect(valid.status).toBe(201);
  });
});
