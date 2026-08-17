import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLeadLag } from './lead-lag-lib.mjs';

function replayCase({ eth1m, sol1m, alt1m, btc1m, future1m, future3m }) {
  return {
    input: {
      snapshot: {
        btcCore: {
          orderFlow: {
            '1m': { priceChangeBps: btc1m },
            '3m': { priceChangeBps: btc1m },
            '5m': { priceChangeBps: btc1m },
          },
        },
        cryptoMarket: {
          leadCore: {
            ETHUSDT: {
              returnsBps: {
                '15s': eth1m,
                '30s': eth1m,
                '1m': eth1m,
                '3m': eth1m,
                '5m': eth1m,
              },
            },
            SOLUSDT: {
              returnsBps: {
                '15s': sol1m,
                '30s': sol1m,
                '1m': sol1m,
                '3m': sol1m,
                '5m': sol1m,
              },
            },
          },
          altMarket: {
            breadth: {
              price: {
                '1m': { medianReturnBps: alt1m },
                '3m': { medianReturnBps: alt1m },
                '5m': { medianReturnBps: alt1m },
              },
              delta: { '1m': { median: alt1m / 100 } },
              openInterest: { '1m': { median: alt1m / 200 } },
            },
            relativeStrength: {
              altMedianMinusBtcBps: {
                '1m': alt1m - btc1m,
                '3m': alt1m - btc1m,
                '5m': alt1m - btc1m,
              },
            },
          },
        },
      },
    },
    outcome: {
      futurePath: {
        returnBps1m: future1m,
        returnBps3m: future3m,
        returnBps5m: future3m,
        returnBps15m: future3m,
      },
    },
  };
}

test('lead lag analyzer reports association without creating a trading rule', () => {
  const cases = [
    replayCase({
      eth1m: -20,
      sol1m: -30,
      alt1m: -25,
      btc1m: -5,
      future1m: -10,
      future3m: -15,
    }),
    replayCase({
      eth1m: -10,
      sol1m: -15,
      alt1m: -12,
      btc1m: -2,
      future1m: -5,
      future3m: -8,
    }),
    replayCase({
      eth1m: 10,
      sol1m: 15,
      alt1m: 12,
      btc1m: 2,
      future1m: 5,
      future3m: 8,
    }),
    replayCase({
      eth1m: 20,
      sol1m: 30,
      alt1m: 25,
      btc1m: 5,
      future1m: 10,
      future3m: 15,
    }),
    replayCase({
      eth1m: 30,
      sol1m: 40,
      alt1m: 35,
      btc1m: 8,
      future1m: 20,
      future3m: 25,
    }),
  ];

  const result = analyzeLeadLag(cases, { minSamples: 5 });
  const stats = result.features.ETH_RETURN_1M['1m'];

  assert.equal(result.version, 'lead-lag-research-v1');
  assert.equal(result.objectiveOnly, true);
  assert.equal(result.usableCases, 5);
  assert.equal(stats.sampleStatus, 'RESEARCH_READY');
  assert.ok((stats.spearmanCorrelation ?? 0) > 0.9);
  assert.equal(result.interpretationBoundary.causalClaim, false);
  assert.equal(result.interpretationBoundary.liveTradingRule, false);
  assert.equal(result.interpretationBoundary.automaticPromotion, false);
  assert.equal('signal' in result, false);
  assert.equal('recommendedSide' in result, false);
});

test('lead lag analyzer preserves sparse status and missing auxiliary evidence', () => {
  const cases = [
    {
      input: { snapshot: { btcCore: {}, cryptoMarket: null } },
      outcome: { futurePath: { returnBps1m: 1 } },
    },
  ];

  const result = analyzeLeadLag(cases, { minSamples: 20 });
  assert.equal(result.usableCases, 0);
  assert.equal(result.features.ETH_RETURN_1M['1m'].sampleCount, 0);
  assert.equal(result.features.ETH_RETURN_1M['1m'].sampleStatus, 'SPARSE');
});
