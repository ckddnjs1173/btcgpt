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
  assert.ok(
    Math.abs(lead.deltas.costPerMatchedCaseUsd - 0.001) < 1e-12,
  );
});

test(
  'marks profile comparison invalid when matched frozen case counts drift',
  () => {
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
  },
);

test(
  'preserves unavailable benchmark failures instead of inventing metrics',
  () => {
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
  },
);

test('formats markdown with explicit interpretation boundaries', () => {
  const campaign = manifest();
  const report = buildEvidenceAblationReport(campaign, {
    'base-001-abl-0-baseline': benchmark(),
    'base-001-abl-1-lead-core': benchmark(),
    'base-001-abl-2-alt-breadth': benchmark(),
  });
  const markdown = formatEvidenceAblationMarkdown(report);

  assert.match(markdown, /BASELINE → LEAD_CORE/);
  assert.match(markdown, /does not select a winner/i);
  assert.match(markdown, /separate evidence vectors/i);
});
