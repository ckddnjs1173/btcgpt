import { describe, it, expect } from 'vitest';
import { handler } from '../../worker/src/index';

describe('worker handler', () => {
  const env = {
    UPLOADER_WRITE_KEY: 'upload-secret',
    ACTION_READ_KEY: 'read-secret',
  };

  it('responds to health', async () => {
    const res = await handler(new Request('https://example.com/health'), env);
    const json = (await res.json()) as { ok?: boolean };
    expect(json.ok).toBe(true);
  });

  it('PUT and GET snapshot', async () => {
    const payload = {
      schemaVersion: 1,
      snapshotId: 'test',
      symbol: 'BTCUSDT',
      market: 'BINANCE_USDM_PERPETUAL',
      generatedAt: Date.now(),
      analysisGate: { analysisAllowed: true, overallStatus: 'NORMAL' },
    };
    const put = await handler(
      new Request('https://example.com/v1/snapshot/latest', {
        method: 'PUT',
        headers: { authorization: 'Bearer upload-secret' },
        body: JSON.stringify(payload),
      }),
      env,
    );
    expect(put.status).toBe(200);
    const get = await handler(
      new Request('https://example.com/v1/snapshot/latest', {
        headers: { authorization: 'Bearer read-secret' },
      }),
      env,
    );
    const json = (await get.json()) as { symbol: string };
    expect(json.symbol).toBe('BTCUSDT');
  });

  it('separates upload and read credentials', async () => {
    const denied = await handler(
      new Request('https://example.com/v1/snapshot/latest', {
        headers: { authorization: 'Bearer upload-secret' },
      }),
      env,
    );
    expect(denied.status).toBe(401);
  });

  it('rejects snapshots containing secret or account identifier fields', async () => {
    const response = await handler(
      new Request('https://example.com/v1/snapshot/latest', {
        method: 'PUT',
        headers: { authorization: 'Bearer upload-secret' },
        body: JSON.stringify({
          schemaVersion: 1,
          snapshotId: 'unsafe',
          symbol: 'BTCUSDT',
          market: 'BINANCE_USDM_PERPETUAL',
          generatedAt: Date.now(),
          analysisGate: {
            analysisAllowed: false,
            overallStatus: 'STALE',
          },
          account: { accountId: 'private' },
        }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('FORBIDDEN_SNAPSHOT_FIELD');
  });

  it('validates quantity from risk inputs and the latest snapshot filters', async () => {
    const payload = {
      schemaVersion: 1,
      snapshotId: 'plan-source',
      symbol: 'BTCUSDT',
      market: 'BINANCE_USDM_PERPETUAL',
      generatedAt: Date.now(),
      analysisGate: { analysisAllowed: true, overallStatus: 'NORMAL' },
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
      account: { availableBalance: 1_000 },
    };
    await handler(
      new Request('https://example.com/v1/snapshot/latest', {
        method: 'PUT',
        headers: { authorization: 'Bearer upload-secret' },
        body: JSON.stringify(payload),
      }),
      env,
    );
    const response = await handler(
      new Request('https://example.com/v1/plan/validate', {
        method: 'POST',
        headers: { authorization: 'Bearer read-secret' },
        body: JSON.stringify({
          side: 'LONG',
          entry: 60_000,
          stop: 59_500,
          targets: [61_000, 62_000],
          maxLossUsdt: 50,
          leverage: 10,
          marginMode: 'ISOLATED',
        }),
      }),
      env,
    );
    const result = (await response.json()) as {
      ok: boolean;
      quantity: number;
      targets: unknown[];
    };
    expect(response.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.quantity).toBeGreaterThan(0);
    expect(result.targets).toHaveLength(2);
  });

  it('does not generate quantity without a risk input', async () => {
    const response = await handler(
      new Request('https://example.com/v1/plan/validate', {
        method: 'POST',
        headers: { authorization: 'Bearer read-secret' },
        body: JSON.stringify({
          side: 'LONG',
          entry: 60_000,
          stop: 59_500,
          targets: [61_000],
          leverage: 10,
          marginMode: 'ISOLATED',
        }),
      }),
      env,
    );
    const result = (await response.json()) as {
      errors: string[];
      quantity?: number;
    };
    expect(response.status).toBe(400);
    expect(result.errors).toContain('RISK_INPUT_REQUIRED');
    expect(result.quantity).toBeUndefined();
  });

  it('returns no calculation values when required cost settings are missing', async () => {
    const now = Date.now();
    await handler(
      new Request('https://example.com/v1/snapshot/latest', {
        method: 'PUT',
        headers: { authorization: 'Bearer upload-secret' },
        body: JSON.stringify({
          schemaVersion: 1,
          snapshotId: 'missing-costs',
          symbol: 'BTCUSDT',
          market: 'BINANCE_USDM_PERPETUAL',
          generatedAt: now,
          analysisGate: { analysisAllowed: true, overallStatus: 'NORMAL' },
          productFilters: {
            tickSize: 0.1,
            stepSize: 0.001,
            minQuantity: 0.001,
            minNotional: 5,
          },
          costSettings: {
            makerFeeRate: null,
            takerFeeRate: null,
            entrySlippageBps: null,
            exitSlippageBps: null,
          },
        }),
      }),
      env,
    );
    const response = await handler(
      new Request('https://example.com/v1/plan/validate', {
        method: 'POST',
        headers: { authorization: 'Bearer read-secret' },
        body: JSON.stringify({
          side: 'LONG',
          entry: 60_000,
          stop: 59_500,
          targets: [61_000],
          maxLossUsdt: 50,
          leverage: 10,
          marginMode: 'ISOLATED',
        }),
      }),
      env,
    );
    const result = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(400);
    expect(result.errors).toEqual([
      'ENTRY_FEE_RATE_REQUIRED',
      'EXIT_FEE_RATE_REQUIRED',
      'ENTRY_SLIPPAGE_REQUIRED',
      'EXIT_SLIPPAGE_REQUIRED',
    ]);
    expect(Object.keys(result).sort()).toEqual(['errors', 'ok', 'warnings']);
  });

  it('does not replace a newer snapshot with an older upload', async () => {
    const now = Date.now();
    const upload = (snapshotId: string, generatedAt: number) =>
      handler(
        new Request('https://example.com/v1/snapshot/latest', {
          method: 'PUT',
          headers: { authorization: 'Bearer upload-secret' },
          body: JSON.stringify({
            schemaVersion: 1,
            snapshotId,
            symbol: 'BTCUSDT',
            market: 'BINANCE_USDM_PERPETUAL',
            generatedAt,
            analysisGate: {
              analysisAllowed: true,
              overallStatus: 'NORMAL',
            },
          }),
        }),
        env,
      );
    await upload('newer', now);
    await upload('older', now - 1_000);
    const response = await handler(
      new Request('https://example.com/v1/snapshot/latest', {
        headers: { authorization: 'Bearer read-secret' },
      }),
      env,
    );
    expect(((await response.json()) as { snapshotId: string }).snapshotId).toBe(
      'newer',
    );
  });

  it('upserts and reads the single latest row through the D1 binding', async () => {
    let row: {
      raw: string;
      generatedAt: number;
      receivedAt: number;
    } | null = null;
    const database = {
      prepare(query: string) {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) {
            values = next;
            return this;
          },
          run() {
            expect(query).toContain('latest_snapshot');
            row = {
              raw: String(values[0]),
              generatedAt: Number(values[1]),
              receivedAt: Number(values[2]),
            };
            return Promise.resolve({ success: true });
          },
          first<T>() {
            return Promise.resolve(row as T | null);
          },
        };
      },
    };
    const d1Env = { ...env, DB: database };
    const payload = {
      schemaVersion: 1,
      snapshotId: 'd1',
      symbol: 'BTCUSDT',
      market: 'BINANCE_USDM_PERPETUAL',
      generatedAt: Date.now(),
      analysisGate: { analysisAllowed: false, overallStatus: 'STALE' },
    };
    expect(
      (
        await handler(
          new Request('https://example.com/v1/snapshot/latest', {
            method: 'PUT',
            headers: { authorization: 'Bearer upload-secret' },
            body: JSON.stringify(payload),
          }),
          d1Env,
        )
      ).status,
    ).toBe(200);
    const read = await handler(
      new Request('https://example.com/v1/snapshot/latest', {
        headers: { authorization: 'Bearer read-secret' },
      }),
      d1Env,
    );
    expect(((await read.json()) as { snapshotId: string }).snapshotId).toBe(
      'd1',
    );
  });
});
