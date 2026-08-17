import { describe, expect, it } from 'vitest';

import { ExternalProviderRegistry } from '../../src/main/external/provider-registry';
import type { ExternalIntelligenceProvider } from '../../src/main/external/provider-contracts';

function provider(
  providerId: string,
  kind: ExternalIntelligenceProvider<unknown>['kind'],
  fetcher: ExternalIntelligenceProvider<unknown>['fetch'],
): ExternalIntelligenceProvider<unknown> {
  return { providerId, kind, fetch: fetcher };
}

describe('ExternalProviderRegistry', () => {
  it('isolates optional provider failures and preserves successful evidence', async () => {
    const registry = new ExternalProviderRegistry([
      provider('GOOD', 'ETF', (now = 1_000) =>
        Promise.resolve({
          providerId: 'GOOD',
          kind: 'ETF',
          generatedAt: now,
          payload: { netFlowUsd: 123 },
          provenance: [],
          items: [],
        }),
      ),
      provider('BAD', 'ESTIMATED_LIQUIDATION', () =>
        Promise.reject(new Error('UPSTREAM_DOWN')),
      ),
    ]);

    const snapshot = await registry.fetchAll(1_000);

    expect(snapshot.results).toHaveLength(1);
    expect(snapshot.results[0]?.providerId).toBe('GOOD');
    expect(snapshot.health).toEqual([
      {
        providerId: 'BAD',
        kind: 'ESTIMATED_LIQUIDATION',
        status: 'DISCONNECTED',
        lastSuccessAt: null,
        lastFailureAt: 1_000,
        consecutiveFailures: 1,
        error: 'UPSTREAM_DOWN',
      },
      {
        providerId: 'GOOD',
        kind: 'ETF',
        status: 'NORMAL',
        lastSuccessAt: 1_000,
        lastFailureAt: null,
        consecutiveFailures: 0,
        error: null,
      },
    ]);
  });

  it('marks later failures degraded after a successful observation', async () => {
    let shouldFail = false;
    const registry = new ExternalProviderRegistry([
      provider('OPTIONAL', 'ONCHAIN', (now = 1_000) => {
        if (shouldFail) return Promise.reject(new Error('TEMPORARY_FAILURE'));
        return Promise.resolve({
          providerId: 'OPTIONAL',
          kind: 'ONCHAIN',
          generatedAt: now,
          payload: {},
          provenance: [],
          items: [],
        });
      }),
    ]);

    await registry.fetchAll(1_000);
    shouldFail = true;
    const second = await registry.fetchAll(2_000);

    expect(second.results).toHaveLength(0);
    expect(second.health[0]).toMatchObject({
      providerId: 'OPTIONAL',
      status: 'DEGRADED',
      lastSuccessAt: 1_000,
      lastFailureAt: 2_000,
      consecutiveFailures: 1,
    });
  });

  it('rejects duplicate IDs and provider identity mismatches', async () => {
    const registry = new ExternalProviderRegistry();
    registry.register(
      provider('ONE', 'DERIVATIVES_AGGREGATE', (now = 1_000) =>
        Promise.resolve({
          providerId: 'WRONG',
          kind: 'DERIVATIVES_AGGREGATE',
          generatedAt: now,
          payload: {},
          provenance: [],
          items: [],
        }),
      ),
    );

    expect(() =>
      registry.register(
        provider('ONE', 'ETF', () =>
          Promise.reject(new Error('unused')),
        ),
      ),
    ).toThrow('PROVIDER_DUPLICATE:ONE');

    const snapshot = await registry.fetchAll(1_000);
    expect(snapshot.results).toHaveLength(0);
    expect(snapshot.health[0]).toMatchObject({
      status: 'DISCONNECTED',
      error: 'PROVIDER_ID_MISMATCH',
    });
  });
});
