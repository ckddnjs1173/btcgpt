// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { MarketDataService } from '../../src/main/market/service';
import { generateSnapshot } from '../../src/main/market/snapshot';
import type { Candle } from '../../src/main/market/types';

const enabled = process.env.RUN_SOAK === '1';
const durationMs = Number(process.env.SOAK_DURATION_MS ?? 28_800_000);
const sampleIntervalMs = Number(process.env.SOAK_SAMPLE_MS ?? 30_000);

describe.skipIf(!enabled)('Binance public market soak', () => {
  it(
    'keeps the complete public market service bounded and recoverable',
    async () => {
      const persisted = new Map<string, Candle>();
      const repository = {
        readClosedCandles: () => [] as Candle[],
        upsertClosedCandle(candle: Candle) {
          if (candle.isClosed)
            persisted.set(`${candle.timeframe}:${candle.openTime}`, candle);
        },
      };
      const service = new MarketDataService(repository);
      const startedRss = process.memoryUsage().rss;
      let peakRss = startedRss;
      let samples = 0;
      let usableSamples = 0;
      let maxPayloadBytes = 0;
      let maxReconnects = 0;

      await service.start();
      try {
        const warmupDeadline = Date.now() + 60_000;
        while (
          !['NORMAL', 'DELAYED'].includes(service.cache.health().status) &&
          Date.now() < warmupDeadline
        )
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(['NORMAL', 'DELAYED']).toContain(service.cache.health().status);

        const end = Date.now() + durationMs;
        while (Date.now() < end) {
          const status = service.cache.status();
          for (const count of Object.values(status.timeframeCounts))
            expect(count).toBeGreaterThanOrEqual(250);

          const snapshot = generateSnapshot(service.cache, {
            serverTime: Date.now() + service.getServerOffsetMs(),
          });
          const payloadBytes = new TextEncoder().encode(
            JSON.stringify(snapshot),
          ).byteLength;
          expect(payloadBytes).toBeLessThanOrEqual(90_000);
          maxPayloadBytes = Math.max(maxPayloadBytes, payloadBytes);

          const health = service.cache.health();
          if (health.status === 'NORMAL' || health.status === 'DELAYED')
            usableSamples += 1;
          maxReconnects = Math.max(maxReconnects, health.reconnectCount);
          samples += 1;
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
          await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
        }

        expect(samples).toBeGreaterThan(0);
        expect(usableSamples / samples).toBeGreaterThanOrEqual(0.95);
        expect(peakRss - startedRss).toBeLessThan(256 * 1024 * 1024);
        expect(persisted.size).toBeGreaterThanOrEqual(1_000);
        expect(maxPayloadBytes).toBeGreaterThan(0);
        expect(maxReconnects).toBeGreaterThanOrEqual(0);
      } finally {
        service.stop();
      }
    },
    durationMs + 120_000,
  );
});
