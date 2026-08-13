import { beforeEach, describe, expect, it } from 'vitest';

import { handler, type Env } from '../../worker/src/index';

type StoredRow = {
  raw: string;
  generatedAt: number;
  receivedAt: number;
};

class MemoryD1 {
  private snapshot: StoredRow | null = null;
  private tradingState: StoredRow | null = null;
  private readonly contexts = new Map<string, StoredRow>();
  private riskContext: { raw: string; generatedAt: number } | null = null;

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
          if (!this.snapshot || generatedAt >= this.snapshot.generatedAt)
            this.snapshot = { raw, generatedAt, receivedAt };
        } else if (query.includes('INSERT INTO latest_trading_state')) {
          const [raw, generatedAt, receivedAt] = values as [
            string,
            number,
            number,
          ];
          if (
            !this.tradingState ||
            generatedAt >= this.tradingState.generatedAt
          )
            this.tradingState = { raw, generatedAt, receivedAt };
        } else if (query.includes('INSERT INTO external_context_payloads')) {
          const [horizon, raw, generatedAt, receivedAt] = values as [
            string,
            string,
            number,
            number,
          ];
          const current = this.contexts.get(horizon);
          if (!current || generatedAt >= current.generatedAt)
            this.contexts.set(horizon, { raw, generatedAt, receivedAt });
        } else if (query.includes('INSERT INTO external_context_summary')) {
          const [raw, generatedAt] = values as [string, number, number];
          if (!this.riskContext || generatedAt >= this.riskContext.generatedAt)
            this.riskContext = { raw, generatedAt };
        }
        return Promise.resolve({ success: true });
      },
      first: <T>(): Promise<T | null> => {
        if (query.includes('SELECT 1 AS ok'))
          return Promise.resolve({ ok: 1 } as T);
        if (query.includes('FROM latest_snapshot'))
          return Promise.resolve(this.snapshot as T | null);
        if (query.includes('FROM latest_trading_state'))
          return Promise.resolve(this.tradingState as T | null);
        if (query.includes('FROM external_context_payloads'))
          return Promise.resolve(
            (this.contexts.get(String(values[0])) ?? null) as T | null,
          );
        if (query.includes('FROM external_context_summary'))
          return Promise.resolve(this.riskContext as T | null);
        return Promise.resolve(null);
      },
    };
    return statement;
  }
}

function decisionGates(entryAllowed = true) {
  const now = Date.now();
  return {
    marketAnalysisAvailable: true,
    entryAllowed,
    positionManagementAvailable: true,
    quality: entryAllowed ? ('GREEN' as const) : ('YELLOW' as const),
    generatedAt: now,
    publishedAt: null,
    ageMs: 0,
    marketDataAgeMs: 0,
    relayPublishAgeMs: null,
    criticalBlockers: entryAllowed ? [] : ['ENTRY_TEST_BLOCKED'],
    degradedSources: [],
    missingFields: [],
  };
}

function snapshotFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Date.now();
  return {
    schemaVersion: 5,
    appVersion: '0.5.5',
    snapshotId: 'snapshot-a',
    symbol: 'BTCUSDT',
    market: 'BINANCE_USDM_PERPETUAL',
    generatedAt: now,
    analysisGate: {
      analysisAllowed: true,
      overallStatus: 'NORMAL',
      generatedAt: now,
      publishedAt: null,
      ageMs: 0,
      reasons: [],
      missingFields: [],
    },
    decisionGates: decisionGates(true),
    scalpContext: {},
    timeframes: { '1m': {} },
    marketState: { fundingRate: 0.0001 },
    productFilters: {
      tickSize: 0.1,
      stepSize: 0.001,
      minQuantity: 0.001,
      minNotional: 5,
    },
    costSettings: {
      makerFeeRate: 0.0002,
      takerFeeRate: 0.0005,
      entrySlippageBps: 1,
      exitSlippageBps: 1,
    },
    account: {
      availableBalance: 2_000,
      leverageBrackets: [
        {
          initialLeverage: 125,
          notionalFloor: 0,
          notionalCap: 50_000,
          maintenanceMarginRate: 0.004,
          updatedAt: now,
        },
      ],
    },
    strategy: {
      maxLossUsdt: 100,
      riskPercent: null,
    },
    ...overrides,
  };
}

function planFixture(overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: 'snapshot-a',
    side: 'LONG',
    entry: 60_000,
    stop: 59_500,
    targets: [61_000],
    leverage: 50,
    marginMode: 'ISOLATED',
    sizeMode: 'MARGIN_USDT',
    sizeValue: 60,
    entryOrderType: 'TAKER',
    exitOrderType: 'TAKER',
    expectedFundingPeriods: 0,
    ...overrides,
  };
}

async function uploadSnapshot(env: Env, snapshot = snapshotFixture()) {
  return handler(
    new Request('https://example.com/v1/snapshot/latest', {
      method: 'PUT',
      headers: { authorization: 'Bearer upload-secret' },
      body: JSON.stringify(snapshot),
    }),
    env,
  );
}

describe('worker handler', () => {
  let env: Env;

  beforeEach(() => {
    env = {
      DB: new MemoryD1(),
      UPLOADER_WRITE_KEY: 'upload-secret',
      ACTION_READ_KEY: 'read-secret',
    };
  });

  it('reports D1 health', async () => {
    const response = await handler(
      new Request('https://example.com/health'),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, storage: 'D1' });
  });

  it('separates upload and action credentials', async () => {
    const denied = await handler(
      new Request('https://example.com/v1/snapshot/latest', {
        headers: { authorization: 'Bearer upload-secret' },
      }),
      env,
    );
    expect(denied.status).toBe(401);
  });

  it('accepts schema v5 snapshots and rejects forbidden fields', async () => {
    expect((await uploadSnapshot(env)).status).toBe(200);
    const unsafe = await uploadSnapshot(
      env,
      snapshotFixture({ accountId: 'private-account' }),
    );
    expect(unsafe.status).toBe(400);
    expect(await unsafe.text()).toContain('FORBIDDEN_SNAPSHOT_FIELD');
  });

  it('uses decisionGates.entryAllowed for schema v5 plans', async () => {
    await uploadSnapshot(
      env,
      snapshotFixture({ decisionGates: decisionGates(false) }),
    );
    const response = await handler(
      new Request('https://example.com/v1/plan/validate', {
        method: 'POST',
        headers: { authorization: 'Bearer read-secret' },
        body: JSON.stringify(planFixture()),
      }),
      env,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      errors: ['ENTRY_NOT_ALLOWED'],
    });
  });

  it('binds validation to the analyzed snapshot when snapshotId is supplied', async () => {
    await uploadSnapshot(env);
    const response = await handler(
      new Request('https://example.com/v1/plan/validate', {
        method: 'POST',
        headers: { authorization: 'Bearer read-secret' },
        body: JSON.stringify(planFixture({ snapshotId: 'older-snapshot' })),
      }),
      env,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      errors: ['SNAPSHOT_CHANGED_REVALIDATE'],
    });
  });

  it('calculates target ROI with the selected non-default leverage', async () => {
    await uploadSnapshot(env);
    const response = await handler(
      new Request('https://example.com/v1/plan/validate', {
        method: 'POST',
        headers: { authorization: 'Bearer read-secret' },
        body: JSON.stringify(planFixture()),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      ok: boolean;
      quantity: number;
      initialMargin: number;
      targets: Array<{ initialMargin: number; netMarginRoiPercent: number }>;
      calculationSource: { snapshotId: string };
    };
    expect(result.ok).toBe(true);
    expect(result.quantity).toBeCloseTo(0.05, 8);
    expect(result.initialMargin).toBeCloseTo(60, 8);
    expect(result.targets[0]?.initialMargin).toBeCloseTo(60, 8);
    expect(result.targets[0]?.netMarginRoiPercent).toBeGreaterThan(0);
    expect(result.calculationSource.snapshotId).toBe('snapshot-a');
  });

  it('does not replace a newer snapshot with an older upload', async () => {
    const now = Date.now();
    await uploadSnapshot(
      env,
      snapshotFixture({ snapshotId: 'newer', generatedAt: now }),
    );
    await uploadSnapshot(
      env,
      snapshotFixture({ snapshotId: 'older', generatedAt: now - 1_000 }),
    );
    const response = await handler(
      new Request('https://example.com/v1/snapshot/latest', {
        headers: { authorization: 'Bearer read-secret' },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ snapshotId: 'newer' });
  });
});
