import type {
  ExternalIntelligenceProvider,
  ExternalProviderKind,
  ProviderFetchResult,
} from './provider-contracts';

export type ProviderRegistryStatus =
  | 'NORMAL'
  | 'DEGRADED'
  | 'DISCONNECTED'
  | 'DISABLED';

export interface ProviderRegistryHealth {
  providerId: string;
  kind: ExternalProviderKind;
  status: ProviderRegistryStatus;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  error: string | null;
}

export interface ProviderRegistrySnapshot {
  generatedAt: number;
  results: ProviderFetchResult<unknown>[];
  health: ProviderRegistryHealth[];
}

function providerError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 160)
    : 'PROVIDER_FETCH_FAILED';
}

export class ExternalProviderRegistry {
  private readonly providers = new Map<
    string,
    ExternalIntelligenceProvider<unknown>
  >();
  private readonly health = new Map<string, ProviderRegistryHealth>();

  constructor(providers: ExternalIntelligenceProvider<unknown>[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ExternalIntelligenceProvider<unknown>): void {
    if (!provider.providerId.trim()) throw new Error('PROVIDER_ID_REQUIRED');
    if (this.providers.has(provider.providerId))
      throw new Error(`PROVIDER_DUPLICATE:${provider.providerId}`);
    this.providers.set(provider.providerId, provider);
    this.health.set(provider.providerId, {
      providerId: provider.providerId,
      kind: provider.kind,
      status: 'DISCONNECTED',
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      error: null,
    });
  }

  unregister(providerId: string): boolean {
    this.health.delete(providerId);
    return this.providers.delete(providerId);
  }

  list(): ProviderRegistryHealth[] {
    return [...this.health.values()]
      .map((row) => ({ ...row }))
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  async fetchAll(now = Date.now()): Promise<ProviderRegistrySnapshot> {
    const providers = [...this.providers.values()];
    const settled = await Promise.all(
      providers.map(async (provider) => {
        const state = this.health.get(provider.providerId);
        if (!state) throw new Error('PROVIDER_HEALTH_MISSING');
        try {
          const result = await provider.fetch(now);
          if (result.providerId !== provider.providerId)
            throw new Error('PROVIDER_ID_MISMATCH');
          if (result.kind !== provider.kind)
            throw new Error('PROVIDER_KIND_MISMATCH');
          state.status = 'NORMAL';
          state.lastSuccessAt = now;
          state.consecutiveFailures = 0;
          state.error = null;
          return result;
        } catch (error) {
          state.status = state.lastSuccessAt === null ? 'DISCONNECTED' : 'DEGRADED';
          state.lastFailureAt = now;
          state.consecutiveFailures += 1;
          state.error = providerError(error);
          return null;
        }
      }),
    );

    return {
      generatedAt: now,
      results: settled.filter(
        (result): result is ProviderFetchResult<unknown> => result !== null,
      ),
      health: this.list(),
    };
  }
}
