import { describe, expect, it } from 'vitest';

import type { MarketSnapshot } from '../../src/shared/contracts';
import {
  buildLocalMarketIntelligence,
  localMarketIntelligenceSchema,
} from '../../src/shared/decision-context';
import {
  createCompactRelaySnapshot,
  RELAY_SNAPSHOT_MAX_BYTES,
} from '../../src/main/market/compact-snapshot';
import { RELAY_UPLOAD_INTERVAL_MS } from '../../src/main/relay/uploader';
import { buildDecisionContext } from '../../worker/src/decision-context';
import { applyRelayFreshness } from '../../worker/src/relay-freshness';

const NOW = 1_800_000_000_000;

function localMarket() {
  return buildLocalMarketIntelligence({
    generatedAt: NOW,
    leadCore: { ETHUSDT: null, SOLUSDT: null },
    altMarket: null,
    evidenceHealth: [],
  });
}

function minimalSnapshot(): MarketSnapshot {
  const timeframe = { closed: [] };
  return {
    snapshotId: 'snap-v1',
    generatedAt: NOW,
    timeframes: {
      '1m': timeframe,
      '3m': timeframe,
      '5m': timeframe,
      '15m': timeframe,
      '30m': timeframe,
      '1h': timeframe,
      '4h': timeframe,
      '1d': timeframe,
      '1w': timeframe,
    },
    account: { openOrders: [], recentTrades: [] },
    trading: {
      liveManual: { protectiveOrders: [], recentTrades: [] },
    },
  } as unknown as MarketSnapshot;
}

describe('decision-context-v1 transport', () => {
  it('keeps market intelligence inside the same compact relay snapshot', () => {
    const compact = createCompactRelaySnapshot(
      minimalSnapshot(),
      localMarket(),
    );

    expect(compact.snapshot.snapshotId).toBe('snap-v1');
    expect(compact.snapshot.marketIntelligence?.version).toBe(
      'local-market-v1',
    );
    expect(compact.snapshot.marketIntelligence?.generatedAt).toBe(NOW);
    expect(compact.byteLength).toBeLessThan(RELAY_SNAPSHOT_MAX_BYTES);
  });

  it('uses the approved two-second relay target', () => {
    expect(RELAY_UPLOAD_INTERVAL_MS).toBe(2_000);
  });

  it('rejects signal-like unknown fields in the strict local market envelope', () => {
    expect(() =>
      localMarketIntelligenceSchema.parse({
        ...localMarket(),
        longSignal: true,
      }),
    ).toThrow();
  });
});

describe('relay freshness compatibility', () => {
  it('blocks stale BTC entry without deriving any auxiliary trade decision', () => {
    const snapshot = {
      decisionGates: {
        marketAnalysisAvailable: true,
        entryAllowed: true,
        positionManagementAvailable: true,
        quality: 'GREEN',
        criticalBlockers: [],
        degradedSources: [],
      },
      analysisGate: {
        analysisAllowed: true,
        overallStatus: 'NORMAL',
        reasons: [],
      },
    };

    const stale = applyRelayFreshness(
      snapshot,
      NOW - 31_000,
      NOW - 30_000,
      NOW,
    );
    const gates = stale.decisionGates as Record<string, unknown>;

    expect(gates.entryAllowed).toBe(false);
    expect(gates.marketAnalysisAvailable).toBe(false);
    expect(gates.positionManagementAvailable).toBe(false);
    expect(gates.criticalBlockers).toContain('RELAY_SNAPSHOT_STALE');
    expect(JSON.stringify(stale)).not.toMatch(
      /longSignal|shortSignal|buySignal|sellSignal/i,
    );
  });

  it('keeps position management available in the entry-stale window', () => {
    const snapshot = {
      decisionGates: {
        marketAnalysisAvailable: true,
        entryAllowed: true,
        positionManagementAvailable: true,
        quality: 'GREEN',
        criticalBlockers: [],
        degradedSources: [],
      },
      analysisGate: {
        analysisAllowed: true,
        overallStatus: 'NORMAL',
        reasons: [],
      },
    };

    const delayed = applyRelayFreshness(
      snapshot,
      NOW - 20_000,
      NOW - 19_000,
      NOW,
    );
    const gates = delayed.decisionGates as Record<string, unknown>;

    expect(gates.entryAllowed).toBe(false);
    expect(gates.marketAnalysisAvailable).toBe(false);
    expect(gates.positionManagementAvailable).toBe(true);
  });
});

describe('Worker decision context builder', () => {
  it('preserves snapshot anchors and exposes auxiliary evidence separately', () => {
    const cryptoMarket = localMarket();
    const snapshot = {
      snapshotId: 'snap-v1',
      generatedAt: NOW - 1_000,
      marketIntelligence: cryptoMarket,
    };
    const contextPack = {
      version: 'context-v2',
      generatedAt: NOW,
      snapshotId: 'snap-v1',
      marketGeneratedAt: NOW - 1_000,
      objectiveOnly: true,
      btcCore: {
        decisionGates: {
          marketAnalysisAvailable: true,
          entryAllowed: true,
          positionManagementAvailable: true,
          quality: 'GREEN',
          criticalBlockers: [],
          degradedSources: [],
        },
      },
      crossMarket: { completeness: 1 },
      external: { status: 'NORMAL' },
      tradingMemory: { status: 'SPARSE' },
      reasoningPolicy: { recommendedMode: 'FAST' },
      positionManagement: { status: 'FLAT' },
      routing: { sourceSet: ['BINANCE_BTC_LOCAL'] },
      completeness: {
        crossMarket: 1,
        externalAvailable: true,
        btcDecisionGateQuality: 'GREEN',
        memoryStatus: 'SPARSE',
        managementStatus: 'FLAT',
      },
    } as unknown as Parameters<typeof buildDecisionContext>[0]['contextPack'];

    const result = buildDecisionContext({
      snapshot,
      contextPack,
      relayReceivedAt: NOW - 500,
      actionStartedAt: NOW,
      generatedAt: NOW + 10,
    });

    expect(result.version).toBe('decision-context-v1');
    expect(result.snapshotId).toBe('snap-v1');
    expect(result.marketGeneratedAt).toBe(NOW - 1_000);
    expect(result.cryptoMarket?.version).toBe('local-market-v1');
    expect(result.evidence.cryptoMarketAvailable).toBe(true);
    expect(result.completeness.leadAssetsAvailable).toBe(0);
    expect(result.timing.marketToRelayMs).toBe(500);
    expect(result.timing.relayToActionStartMs).toBe(500);
  });
});
