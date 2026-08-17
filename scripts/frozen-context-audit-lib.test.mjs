import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditFrozenReplayInput,
  buildFrozenContextAudit,
  formatFrozenContextAuditMarkdown,
} from './frozen-context-audit-lib.mjs';

function replayInput(overrides = {}) {
  return {
    snapshot: {
      version: 'decision-context-v1',
      snapshotId: 'snap-1',
      generatedAt: 10_100,
      marketGeneratedAt: 9_000,
      decisionGates: {
        quality: 'GREEN',
        marketAnalysisAvailable: true,
        entryAllowed: true,
        positionManagementAvailable: true,
      },
      timing: {
        marketAgeMs: 1_100,
        marketToRelayMs: 400,
        relayToActionStartMs: 600,
        contextBuildMs: 100,
      },
      cryptoMarket: {
        version: 'local-market-v2',
        generatedAt: 9_800,
        leadCore: {
          ETHUSDT: { symbol: 'ETHUSDT' },
          SOLUSDT: { symbol: 'SOLUSDT' },
        },
        altMarket: {
          generatedAt: 9_750,
          basketMembers: ['XRPUSDT', 'BNBUSDT'],
          dynamic: [{ symbol: 'XRPUSDT' }],
        },
        crossVenue: {
          generatedAt: 9_700,
          provenance: [
            {
              source: 'COINBASE',
              status: 'NORMAL',
              ageMs: 300,
              collectorLagMs: 40,
              processingLagMs: 10,
            },
          ],
        },
      },
      external: {
        optionsV2: {
          generatedAt: 9_500,
          health: { ageMs: 600 },
          provenance: [
            {
              source: 'DERIBIT',
              status: 'DEGRADED',
              ageMs: 600,
              collectorLagMs: 100,
              processingLagMs: 20,
            },
          ],
        },
        onchainV1: {
          generatedAt: 8_000,
          health: {
            mempoolCollectionAgeMs: 2_000,
            networkDailyCollectionAgeMs: 20_000,
            networkDailyPeriodAgeMs: 80_000,
          },
          provenance: [
            {
              source: 'MEMPOOL',
              status: 'NORMAL',
              ageMs: 2_000,
              collectorLagMs: 50,
              processingLagMs: 10,
            },
          ],
        },
      },
      evidence: {
        cryptoMarketAgeMs: 300,
        auxiliaryEvidenceHealth: [
          {
            sourceKey: 'lead:ETHUSDT:public',
            status: 'NORMAL',
            ageMs: 100,
            normalMaxAgeMs: 1_000,
            usableMaxAgeMs: 2_000,
            consecutiveFailures: 0,
            reconnectCount: 0,
          },
          {
            sourceKey: 'lead:SOLUSDT:public',
            status: 'DEGRADED',
            ageMs: 1_200,
            normalMaxAgeMs: 1_000,
            usableMaxAgeMs: 2_000,
            consecutiveFailures: 1,
            reconnectCount: 1,
          },
          {
            sourceKey: 'alt:dynamic',
            status: 'STALE',
            ageMs: 3_000,
            normalMaxAgeMs: 1_000,
            usableMaxAgeMs: 2_000,
            consecutiveFailures: 2,
            reconnectCount: 0,
          },
          {
            sourceKey: 'cross-venue:coinbase:spot',
            status: 'NORMAL',
            ageMs: 200,
            normalMaxAgeMs: 1_000,
            usableMaxAgeMs: 2_000,
            consecutiveFailures: 0,
            reconnectCount: 0,
          },
        ],
      },
      completeness: {
        cryptoMarketAvailable: true,
        leadAssetsAvailable: 2,
        dynamicAssetCount: 1,
      },
      ...overrides,
    },
  };
}

test('audits frozen evidence axes, freshness metadata and payload size without inference', () => {
  const audit = auditFrozenReplayInput('decision-1', replayInput());

  assert.equal(audit.validDecisionContext, true);
  assert.ok(audit.payloadBytes > 0);
  assert.equal(audit.axes.leadCore.available, true);
  assert.equal(audit.axes.altBreadth.available, true);
  assert.equal(audit.axes.coinbase.available, true);
  assert.equal(audit.axes.optionsV2.available, true);
  assert.equal(audit.axes.onchainV1.available, true);
  assert.equal(audit.axes.optionsV2.reportedAgeMs, 600);
  assert.equal(audit.axes.onchainV1.networkDailyPeriodAgeMs, 80_000);
  assert.equal(audit.health.counts.NORMAL, 2);
  assert.equal(audit.health.counts.DEGRADED, 1);
  assert.equal(audit.health.counts.STALE, 1);
  assert.deepEqual(audit.completeness.mismatches, []);
});

test('reports missing evidence and completeness drift rather than reconstructing it', () => {
  const input = replayInput({
    cryptoMarket: {
      version: 'local-market-v2',
      generatedAt: 9_800,
      leadCore: { ETHUSDT: { symbol: 'ETHUSDT' }, SOLUSDT: null },
      altMarket: null,
      crossVenue: null,
    },
    external: { optionsV2: null, onchainV1: null },
    completeness: {
      cryptoMarketAvailable: true,
      leadAssetsAvailable: 2,
      dynamicAssetCount: 3,
    },
  });
  const audit = auditFrozenReplayInput('decision-2', input);

  assert.equal(audit.axes.leadCore.available, false);
  assert.equal(audit.axes.leadCore.ethAvailable, true);
  assert.equal(audit.axes.leadCore.solAvailable, false);
  assert.equal(audit.axes.altBreadth.available, false);
  assert.equal(audit.axes.coinbase.available, false);
  assert.equal(audit.axes.optionsV2.available, false);
  assert.equal(audit.axes.onchainV1.available, false);
  assert.deepEqual(audit.completeness.mismatches, [
    'LEAD_ASSET_COUNT_MISMATCH',
    'DYNAMIC_ASSET_COUNT_MISMATCH',
  ]);
});

test('marks legacy replay input invalid instead of treating it as decision context', () => {
  const audit = auditFrozenReplayInput('legacy-1', {
    snapshot: { version: 'market-snapshot-v5', generatedAt: 10_000 },
  });

  assert.equal(audit.validDecisionContext, false);
  assert.equal(audit.axes, null);
  assert.equal(audit.health, null);
  assert.equal(audit.inputBasis, 'market-snapshot-v5');
});

test('aggregates availability, timing, source health and contract mismatches', () => {
  const first = auditFrozenReplayInput('decision-1', replayInput());
  const second = auditFrozenReplayInput(
    'decision-2',
    replayInput({
      snapshotId: 'snap-2',
      timing: {
        marketAgeMs: 2_100,
        marketToRelayMs: 800,
        relayToActionStartMs: 1_000,
        contextBuildMs: 200,
      },
      completeness: {
        cryptoMarketAvailable: true,
        leadAssetsAvailable: 1,
        dynamicAssetCount: 1,
      },
    }),
  );
  const legacy = auditFrozenReplayInput('legacy-1', {
    snapshot: { version: 'market-snapshot-v5' },
  });
  const report = buildFrozenContextAudit([first, second, legacy]);

  assert.equal(report.caseCount, 3);
  assert.equal(report.validDecisionContextCases, 2);
  assert.equal(report.invalidDecisionContextCases, 1);
  assert.equal(report.axes.leadCore.availableCases, 2);
  assert.equal(report.axes.leadCore.availabilityRate, 1);
  assert.equal(report.completeness.mismatchCases, 1);
  assert.equal(report.timing.marketAgeMs.p50, 1_600);
  assert.ok(report.health.bySource.length >= 4);
  assert.equal(report.policy.tradingSignal, false);
  assert.equal(report.policy.automaticPromotion, false);
});

test('formats a descriptive markdown audit with explicit boundary', () => {
  const report = buildFrozenContextAudit([
    auditFrozenReplayInput('decision-1', replayInput()),
  ]);
  const markdown = formatFrozenContextAuditMarkdown(report);

  assert.match(markdown, /Evidence availability/);
  assert.match(markdown, /leadCore/);
  assert.match(markdown, /Payload size and latency are reported descriptively/);
  assert.match(markdown, /never creates LONG\/SHORT/);
});
