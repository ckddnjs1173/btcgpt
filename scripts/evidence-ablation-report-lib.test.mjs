import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEvidenceAblationReport,
  formatEvidenceAblationMarkdown,
} from './evidence-ablation-report-lib.mjs';

function manifest() {
  return {
    version: 'evidence-ablation-campaign-v1',
    sourceExperimentId: 'base-001',
    caseCount: 60,
    selectionInvariant: true,
    profiles: [
      {
        order: 0,
        profile: 'BASELINE',
        experimentId: 'base-001-abl-0-baseline',
        enabledSources: [],
      },
      {
        order: 1,
        profile: 'LEAD_CORE',
        experimentId: 'base-001-abl-1-lead-core',
        enabledSources: ['ETH_SOL_LEAD_CORE'],
      },
      {
        order: 2,
        profile: 'ALT_BREADTH',
        experimentId: 'base-001-abl-2-alt-breadth',
        enabledSources: ['ETH_SOL_LEAD_CORE', 'ALT_MARKET_BREADTH'],
      },
    ],
  };
}

function benchmark({
  cases = 60,
  directionalSamples = 30,
  correctRate = 0.5,
  signedReturn = 4,
  abstainSamples = 20,
  abstainOpportunity = 18,
  latency = 1500,
  cost = 0.3,
} = {}) {
  return {
    ok: true,
    status: 200,
    body: {
      matchedCases: cases,
      api: {
        directionalSamples,
        correctRate,
        averageSignedReturnBps30m: signedReturn,
        abstainSamples,
        averageAbstainOpportunityBps30m: abstainOpportunity,
      },
      operational: {
        apiAverageLatencyMs: latency,
        apiTotalReportedCostUsd: cost,
      },
      promotionEvidence: { status: 'READY_FOR_MANUAL_REVIEW' },
    },
  };
}

function pathQuality({
  enterSamples = 20,
  meanMfeR = 1.2,
  meanMaeR = 0.8,
  initialAdverse = 15,
  tp1TargetFirstRate = 0.55,
  tp1StopFirstRate = 0.4,
  waitSamples = 20,
  triggerHitRate = 0.4,
  invalidationRate = 0.2,
  expiredRate = 0.3,
  chaseExceededRate = 0.15,
  postTriggerFavorable = 70,
  postTriggerAdverse = 30,
} = {}) {
  return {
    ok: true,
    status: 200,
    body: {
      enter: {
        samples: enterSamples,
        mfeR: { mean: meanMfeR, median: meanMfeR },
        maeR: { mean: meanMaeR, median: meanMaeR },
        initialAdverseExcursionBps: { mean: initialAdverse },
        timeToMfeMs: { mean: 60_000 },
        timeToMaeMs: { mean: 30_000 },
        tp1Ordering: {
          resolvedSamples: enterSamples,
          targetFirstRate: tp1TargetFirstRate,
          stopFirstRate: tp1StopFirstRate,
          ambiguousRate: 1 - tp1TargetFirstRate - tp1StopFirstRate,
        },
      },
      wait: {
        samples: waitSamples,
        triggerHitRate,
        invalidationBeforeTriggerRate: invalidationRate,
        expiredWithoutTriggerRate: expiredRate,
        timeToTriggerMs: { mean: 45_000 },
        chase: { samples: 8, maxChaseExceededRate: chaseExceededRate },
        postTrigger15m: {
          favorableBps: { mean: postTriggerFavorable },
          adverseBps: { mean: postTriggerAdverse },
        },
      },
      management: {
        samples: 5,
        favorable30mBps: { mean: 80 },
        adverse30mBps: { mean: 35 },
      },
    },
  };
}

test('builds adjacent matched-profile deltas without scalar promotion', () => {
  const campaign = manifest();
  const report = buildEvidenceAblationReport(campaign, {
    'base-001-abl-0-baseline': benchmark(),
    'base-001-abl-1-lead-core': benchmark({
      correctRate: 0.6,
      signedReturn: 7,
      abstainOpportunity: 15,
      latency: 1700,
      cost: 0.36,
    }),
    'base-001-abl-2-alt-breadth': benchmark({
      correctRate: 0.58,
      signedReturn: 6,
      abstainOpportunity: 14,
      latency: 1800,
      cost: 0.42,
    }),
  });

  assert.equal(report.integrity.validForManualComparison, true);
  assert.equal(report.policy.automaticPromotion, false);
  assert.equal(report.policy.scalarWinnerScore, false);
  assert.equal(report.adjacentComparisons.length, 2);

  const lead = report.adjacentComparisons[0];
  assert.deepEqual(lead.addedSources, ['ETH_SOL_LEAD_CORE']);
  assert.equal(lead.comparable, true);
  assert.ok(Math.abs(lead.deltas.directionalAccuracy - 0.1) < 1e-12);
  assert.equal(lead.deltas.averageSignedReturnBps30m, 3);
  assert.equal(lead.deltas.averageAbstainOpportunityBps30m, -3);
  assert.equal(lead.deltas.averageLatencyMs, 200);
  assert.ok(Math.abs(lead.deltas.costPerMatchedCaseUsd - 0.001) < 1e-12);
  assert.equal(lead.pathComparable, false);
});

test('adds descriptive eval-v2 ENTER and WAIT path deltas when available', () => {
  const campaign = manifest();
  const benchmarks = {
    'base-001-abl-0-baseline': benchmark(),
    'base-001-abl-1-lead-core': benchmark(),
    'base-001-abl-2-alt-breadth': benchmark(),
  };
  const paths = {
    'base-001-abl-0-baseline': pathQuality(),
    'base-001-abl-1-lead-core': pathQuality({
      meanMfeR: 1.5,
      meanMaeR: 0.7,
      tp1TargetFirstRate: 0.65,
      tp1StopFirstRate: 0.3,
      triggerHitRate: 0.5,
      invalidationRate: 0.15,
      chaseExceededRate: 0.1,
      postTriggerFavorable: 85,
      postTriggerAdverse: 25,
    }),
    'base-001-abl-2-alt-breadth': pathQuality(),
  };
  const report = buildEvidenceAblationReport(campaign, benchmarks, paths);

  assert.equal(report.integrity.pathQualityProfilesAvailable, 3);
  assert.equal(report.integrity.allPathQualityProfilesAvailable, true);
  const lead = report.adjacentComparisons[0];
  assert.equal(lead.pathComparable, true);
  assert.ok(Math.abs(lead.pathDeltas.enter.meanMfeR - 0.3) < 1e-12);
  assert.ok(Math.abs(lead.pathDeltas.enter.meanMaeR + 0.1) < 1e-12);
  assert.ok(Math.abs(lead.pathDeltas.enter.tp1TargetFirstRate - 0.1) < 1e-12);
  assert.ok(Math.abs(lead.pathDeltas.wait.triggerHitRate - 0.1) < 1e-12);
  assert.ok(
    Math.abs(lead.pathDeltas.wait.invalidationBeforeTriggerRate + 0.05) < 1e-12,
  );
  assert.ok(Math.abs(lead.pathDeltas.wait.maxChaseExceededRate + 0.05) < 1e-12);
});

test('marks profile comparison invalid when matched frozen case counts drift', () => {
  const campaign = manifest();
  const report = buildEvidenceAblationReport(campaign, {
    'base-001-abl-0-baseline': benchmark(),
    'base-001-abl-1-lead-core': benchmark({ cases: 59 }),
    'base-001-abl-2-alt-breadth': benchmark(),
  });

  assert.equal(report.integrity.allProfilesExactCaseCount, false);
  assert.equal(report.integrity.validForManualComparison, false);
  assert.equal(report.adjacentComparisons[0].comparable, false);
  assert.equal(report.adjacentComparisons[1].comparable, false);
});

test('preserves unavailable benchmark failures instead of inventing metrics', () => {
  const campaign = manifest();
  const report = buildEvidenceAblationReport(campaign, {
    'base-001-abl-0-baseline': benchmark(),
    'base-001-abl-1-lead-core': {
      ok: false,
      status: 404,
      body: { error: 'EXPERIMENT_NOT_FOUND' },
    },
    'base-001-abl-2-alt-breadth': benchmark(),
  });

  const missing = report.profiles[1];
  assert.equal(missing.status, 'UNAVAILABLE');
  assert.equal(missing.errorStatus, 404);
  assert.equal(missing.error, 'EXPERIMENT_NOT_FOUND');
  assert.equal(missing.averageSignedReturnBps30m, null);
  assert.equal(report.integrity.validForManualComparison, false);
});

test('formats markdown with explicit path-quality interpretation boundaries', () => {
  const campaign = manifest();
  const benchmarks = {
    'base-001-abl-0-baseline': benchmark(),
    'base-001-abl-1-lead-core': benchmark(),
    'base-001-abl-2-alt-breadth': benchmark(),
  };
  const paths = {
    'base-001-abl-0-baseline': pathQuality(),
    'base-001-abl-1-lead-core': pathQuality(),
    'base-001-abl-2-alt-breadth': pathQuality(),
  };
  const report = buildEvidenceAblationReport(campaign, benchmarks, paths);
  const markdown = formatEvidenceAblationMarkdown(report);

  assert.match(markdown, /BASELINE → LEAD_CORE/);
  assert.match(markdown, /ENTER path quality/);
  assert.match(markdown, /WAIT_TRIGGER path quality/);
  assert.match(markdown, /does not select a winner/i);
  assert.match(markdown, /conditional on the decisions/i);
});
