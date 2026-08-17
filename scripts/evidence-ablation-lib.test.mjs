import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyEvidenceAblation,
  EVIDENCE_ABLATION_PROFILES,
} from './evidence-ablation-lib.mjs';

function replayInput() {
  return {
    decisionId: 'decision-1',
    replayVersion: 'replay-v1',
    inputBasis: 'DECISION_CONTEXT',
    snapshot: {
      version: 'decision-context-v1',
      snapshotId: 'snapshot-1',
      btcCore: { marketState: { markPrice: 60_000 } },
      crossMarket: { completeness: 1 },
      cryptoMarket: {
        version: 'local-market-v2',
        generatedAt: 1_000,
        leadCore: {
          ETHUSDT: { symbol: 'ETHUSDT' },
          SOLUSDT: { symbol: 'SOLUSDT' },
        },
        altMarket: {
          dynamic: [{ symbol: 'ADAUSDT' }],
          breadth: { price: { '5m': { medianReturnBps: 10 } } },
        },
        crossVenue: { version: 'cross-venue-v1', assets: { BTC: {} } },
        evidenceHealth: [
          { sourceKey: 'lead:ETHUSDT:trade-book' },
          { sourceKey: 'alt:ADAUSDT:market' },
          { sourceKey: 'cross-venue:coinbase:BTC-USD' },
        ],
        provenance: [
          {
            source: 'BINANCE_USDM_AGG_TRADE',
            venue: 'BINANCE_USDM',
            instrument: 'ETHUSDT',
          },
          {
            source: 'BINANCE_USDM_ALT_AGG_TRADE',
            venue: 'BINANCE_USDM',
            instrument: 'ADAUSDT',
          },
          {
            source: 'COINBASE_ADVANCED_MARKET_TRADES',
            venue: 'COINBASE_SPOT',
            instrument: 'BTC-USD',
          },
        ],
      },
      external: {
        status: 'NORMAL',
        items: [{ source: 'FED', title: 'macro' }],
        optionsV2: { version: 'deribit-options-v2', dvol: { value: 55 } },
        onchainV1: { version: 'onchain-v1', mempool: { txCount: 1 } },
      },
      evidence: {
        cryptoMarketAvailable: true,
        cryptoMarketGeneratedAt: 1_000,
        cryptoMarketAgeMs: 500,
        auxiliaryEvidenceHealth: [],
        provenance: [],
      },
      completeness: {
        cryptoMarketAvailable: true,
        leadAssetsAvailable: 2,
        dynamicAssetCount: 1,
      },
    },
  };
}

test('profiles are ordered from BTC baseline through on-chain candidate', () => {
  assert.deepEqual(EVIDENCE_ABLATION_PROFILES, [
    'BASELINE',
    'LEAD_CORE',
    'ALT_BREADTH',
    'COINBASE',
    'OPTIONS_V2',
    'ONCHAIN_V1',
  ]);
});

test('baseline removes tested auxiliary axes while preserving BTC and unrelated external context', () => {
  const result = applyEvidenceAblation(replayInput(), 'BASELINE');
  assert.equal(result.applied, true);
  assert.equal(result.replayInput.snapshot.cryptoMarket, null);
  assert.equal(result.replayInput.snapshot.external.optionsV2, null);
  assert.equal(result.replayInput.snapshot.external.onchainV1, null);
  assert.equal(result.replayInput.snapshot.external.items[0].source, 'FED');
  assert.equal(result.replayInput.snapshot.btcCore.marketState.markPrice, 60_000);
  assert.equal(result.replayInput.snapshot.completeness.leadAssetsAvailable, 0);
  assert.equal(result.replayInput.snapshot.completeness.dynamicAssetCount, 0);
});

test('profiles add exactly the intended evidence axes cumulatively', () => {
  const lead = applyEvidenceAblation(replayInput(), 'LEAD_CORE').replayInput
    .snapshot;
  assert.ok(lead.cryptoMarket.leadCore.ETHUSDT);
  assert.equal(lead.cryptoMarket.altMarket, null);
  assert.equal(lead.cryptoMarket.crossVenue, null);
  assert.equal(lead.external.optionsV2, null);
  assert.equal(lead.external.onchainV1, null);
  assert.deepEqual(
    lead.cryptoMarket.evidenceHealth.map((row) => row.sourceKey),
    ['lead:ETHUSDT:trade-book'],
  );

  const alt = applyEvidenceAblation(replayInput(), 'ALT_BREADTH').replayInput
    .snapshot;
  assert.ok(alt.cryptoMarket.altMarket);
  assert.equal(alt.cryptoMarket.crossVenue, null);
  assert.equal(alt.external.optionsV2, null);

  const coinbase = applyEvidenceAblation(replayInput(), 'COINBASE').replayInput
    .snapshot;
  assert.ok(coinbase.cryptoMarket.crossVenue);
  assert.equal(coinbase.external.optionsV2, null);

  const options = applyEvidenceAblation(replayInput(), 'OPTIONS_V2').replayInput
    .snapshot;
  assert.equal(options.external.optionsV2.version, 'deribit-options-v2');
  assert.equal(options.external.onchainV1, null);

  const onchain = applyEvidenceAblation(replayInput(), 'ONCHAIN_V1').replayInput
    .snapshot;
  assert.equal(onchain.external.optionsV2.version, 'deribit-options-v2');
  assert.equal(onchain.external.onchainV1.version, 'onchain-v1');
});

test('legacy market-snapshot replay cases are not falsely labeled as ablated', () => {
  const legacy = { inputBasis: 'MARKET_SNAPSHOT', snapshot: { schemaVersion: 5 } };
  const result = applyEvidenceAblation(legacy, 'BASELINE');
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'DECISION_CONTEXT_REQUIRED');
  assert.deepEqual(result.replayInput, legacy);
});

test('unknown profiles are rejected', () => {
  assert.throws(() => applyEvidenceAblation(replayInput(), 'MAGIC_SIGNAL'));
});
