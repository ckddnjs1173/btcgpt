import { describe, expect, it } from 'vitest';

import { handler, type Env } from '../../worker/src/index';

function envWithSnapshot(snapshot: Record<string, unknown>): Env {
  const now = Date.now();
  const row = {
    raw: JSON.stringify(snapshot),
    generatedAt: snapshot.generatedAt as number,
    receivedAt: now,
  };
  return {
    ACTION_READ_KEY: 'read-key',
    UPLOADER_WRITE_KEY: 'upload-key',
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          run() {
            return Promise.resolve({ success: true });
          },
          first<T>() {
            return Promise.resolve(row as T);
          },
        };
      },
    },
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    schemaVersion: 5,
    snapshotId: 'snapshot-current',
    generatedAt: now,
    analysisGate: {
      analysisAllowed: true,
      overallStatus: 'NORMAL',
      reasons: [],
    },
    decisionGates: {
      marketAnalysisAvailable: true,
      entryAllowed: true,
      positionManagementAvailable: true,
      quality: 'GREEN',
      generatedAt: now,
      publishedAt: now,
      ageMs: 0,
      marketDataAgeMs: 0,
      relayPublishAgeMs: 0,
      criticalBlockers: [],
      degradedSources: [],
      missingFields: [],
    },
    marketState: { markPrice: 100_000 },
    position: {
      source: 'BINANCE_READ_ONLY',
      side: 'LONG',
      quantity: 0.02,
      markPrice: 100_000,
    },
    productFilters: {
      tickSize: 0.1,
      stepSize: 0.001,
      minQuantity: 0.001,
      minNotional: 5,
    },
    costSettings: {
      makerFeeRate: 0.0002,
      takerFeeRate: 0.0005,
      exitSlippageBps: 2,
    },
    trading: {
      liveManual: {
        protectiveCoverage: {
          stopLossQuantity: 0.02,
          takeProfitQuantity: 0.02,
        },
      },
    },
    ...overrides,
  };
}

function request(body: Record<string, unknown>, ip: string) {
  return new Request(
    'https://relay.example/v1/position-adjustment/validate',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer read-key',
        'content-type': 'application/json',
        'cf-connecting-ip': ip,
      },
      body: JSON.stringify(body),
    },
  );
}

describe('position adjustment Action', () => {
  it('rejects a stale snapshot anchor before calculating new Binance inputs', async () => {
    const response = await handler(
      request(
        {
          snapshotId: 'snapshot-old',
          action: 'PARTIAL_EXIT',
          requestedPercent: 25,
        },
        '198.51.100.41',
      ),
      envWithSnapshot(snapshot()),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      ok: boolean;
      errors: string[];
      currentSnapshotId: string;
    };
    expect(body.ok).toBe(false);
    expect(body.errors).toContain('SNAPSHOT_CHANGED_REVALIDATE');
    expect(body.currentSnapshotId).toBe('snapshot-current');
  });

  it('returns aligned Reduce-Only facts for a GPT-selected partial exit', async () => {
    const response = await handler(
      request(
        {
          snapshotId: 'snapshot-current',
          action: 'PARTIAL_EXIT',
          requestedPercent: 33,
          exitOrderType: 'TAKER',
        },
        '198.51.100.42',
      ),
      envWithSnapshot(snapshot()),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.action).toBe('PARTIAL_EXIT');
    expect(body.reduceOnlyRequired).toBe(true);
    expect(body.alignedQuantity).toBe(0.006);
    expect(body.remainingQuantity).toBe(0.014);
    expect(body.positionSource).toBe('BINANCE_READ_ONLY');
  });

  it('does not produce adjustment values when management data is blocked', async () => {
    const blocked = snapshot({
      decisionGates: {
        ...(snapshot().decisionGates as Record<string, unknown>),
        positionManagementAvailable: false,
      },
    });
    const response = await handler(
      request(
        {
          snapshotId: 'snapshot-current',
          action: 'EXIT',
        },
        '198.51.100.43',
      ),
      envWithSnapshot(blocked),
    );
    const body = (await response.json()) as { ok: boolean; errors: string[] };
    expect(body.ok).toBe(false);
    expect(body.errors).toEqual(['POSITION_MANAGEMENT_NOT_AVAILABLE']);
  });
});
