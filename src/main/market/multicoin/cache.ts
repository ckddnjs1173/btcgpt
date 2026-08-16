import type { CryptoAssetObservationBase } from '../../../shared/market-intelligence';

export type ObservationUpsertResult = 'INSERTED' | 'UPDATED' | 'IGNORED_OLDER';

function observationKey(observation: CryptoAssetObservationBase): string {
  return `${observation.venue}:${observation.instrumentType}:${observation.symbol}`;
}

export class MultiCoinObservationCache<
  TObservation extends CryptoAssetObservationBase = CryptoAssetObservationBase,
> {
  private readonly observations = new Map<string, TObservation>();

  upsert(observation: TObservation): ObservationUpsertResult {
    const key = observationKey(observation);
    const current = this.observations.get(key);
    if (
      current &&
      (observation.generatedAt < current.generatedAt ||
        (observation.generatedAt === current.generatedAt &&
          observation.collectorReceivedAt < current.collectorReceivedAt))
    ) {
      return 'IGNORED_OLDER';
    }

    this.observations.set(key, observation);
    return current ? 'UPDATED' : 'INSERTED';
  }

  get(input: {
    venue: string;
    instrumentType: CryptoAssetObservationBase['instrumentType'];
    symbol: string;
  }): TObservation | null {
    return (
      this.observations.get(
        `${input.venue}:${input.instrumentType}:${input.symbol}`,
      ) ?? null
    );
  }

  list(): TObservation[] {
    return [...this.observations.values()].sort((a, b) => {
      const venueOrder = a.venue.localeCompare(b.venue);
      if (venueOrder !== 0) return venueOrder;
      const instrumentOrder = a.instrumentType.localeCompare(b.instrumentType);
      if (instrumentOrder !== 0) return instrumentOrder;
      return a.symbol.localeCompare(b.symbol);
    });
  }

  listByTier(tier: CryptoAssetObservationBase['tier']): TObservation[] {
    return this.list().filter((observation) => observation.tier === tier);
  }

  delete(input: {
    venue: string;
    instrumentType: CryptoAssetObservationBase['instrumentType'];
    symbol: string;
  }): boolean {
    return this.observations.delete(
      `${input.venue}:${input.instrumentType}:${input.symbol}`,
    );
  }

  clear(): void {
    this.observations.clear();
  }

  get size(): number {
    return this.observations.size;
  }
}
