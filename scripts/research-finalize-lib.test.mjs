import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildResearchFinalizationReport,
  formatResearchFinalizationMarkdown,
} from './research-finalize-lib.mjs';

function manifest() {
  return {
    sourceExperimentId: 'source-a',
    caseCount: 3,
    profiles: [
      {
        order: 0,
        profile: 'BASELINE',
        experimentId: 'exp-base',
      },
      {
        order: 1,
        profile: 'LEAD_CORE',
        experimentId: 'exp-lead',
      },
    ],
  };
}

function ablationReport() {
  return {
    integrity: {
      validForManualComparison: true,
      allPathQualityProfilesAvailable: true,
    },
    profiles: [
      { profile: 'BASELINE', experimentId: 'exp-base', matchedCases: 3 },
      { profile: 'LEAD_CORE', experimentId: 'exp-lead', matchedCases: 3 },
    ],
  };
}

function contextAudit() {
  return {
    caseCount: 3,
    validDecisionContextCases: 3,
    invalidDecisionContextCases: 0,
    completeness: { mismatchCases: 0 },
  };
}

function cohortBody(enterRate, waitRate) {
  return {
    rows: {
      parsedEvalV2Scores: 3,
      invalidScorePayloads: 0,
      invalidSnapshotPayloads: 0,
      decisionContextRows: 3,
    },
    decisionMix: {
      samples: 3,
      counts: {
        ENTER: Math.round(enterRate * 3),
        WAIT: Math.round(waitRate * 3),
        ABSTAIN: 0,
        DATA_BLOCKED: 0,
        POSITION_MANAGEMENT: 0,
      },
      rates: {
        ENTER: enterRate,
        WAIT: waitRate,
        ABSTAIN: 0,
        DATA_BLOCKED: 0,
        POSITION_MANAGEMENT: 0,
      },
    },
    regimeDefinition: {
      volatilityFeature: 'btcCore.timeframes.15m.realizedVolatility',
      volatilityMethod: 'EMPIRICAL_TERCILES_OVER_DISTINCT_FROZEN_CASES',
      lowerTercile: 10,
      upperTercile: 20,
      thresholdCaseSamples: 3,
      returnFeature: 'btcCore.timeframes.1h.return12',
      returnMethod: 'SIGN_ONLY_DESCRIPTIVE_BUCKET',
    },
    completenessCohorts: [{ cohort: 'FULL_CORE' }],
    regimeCohorts: [{ cohort: 'LOW_RELATIVE|BTC_1H_RETURN12_POSITIVE' }],
  };
}

function cohortResults() {
  return {
    'exp-base': { ok: true, status: 200, body: cohortBody(1 / 3, 2 / 3) },
    'exp-lead': { ok: true, status: 200, body: cohortBody(2 / 3, 1 / 3) },
  };
}

test('marks the instrumentation loop ready only when every evidence gate is aligned', () => {
  const report = buildResearchFinalizationReport({
    manifest: manifest(),
    ablationReport: ablationReport(),
    contextAudit: contextAudit(),
    cohortResults: cohortResults(),
  });

  assert.equal(report.status, 'READY_FOR_MANUAL_RESEARCH_REVIEW');
  assert.equal(report.integrity.readyForManualResearchReview, true);
  assert.equal(report.handoff.nextStage, 'GPT_INSTRUCTION_ITERATION');
  assert.equal(report.handoff.toolingReady, true);
  assert.equal(report.handoff.evidenceReady, true);
  assert.equal(report.policy.automaticPromotion, false);
  assert.equal(report.policy.liveActivation, false);
  assert.ok(
    Math.abs(report.adjacentComparisons[0].decisionMixRateDeltas.ENTER - 1 / 3) <
      1e-12,
  );
});

test('blocks manual research readiness when frozen context integrity is incomplete', () => {
  const audit = contextAudit();
  audit.invalidDecisionContextCases = 1;
  audit.validDecisionContextCases = 2;
  const report = buildResearchFinalizationReport({
    manifest: manifest(),
    ablationReport: ablationReport(),
    contextAudit: audit,
    cohortResults: cohortResults(),
  });

  assert.equal(report.status, 'BLOCKED_INCOMPLETE_RESEARCH_EVIDENCE');
  assert.equal(report.integrity.contextAuditComplete, false);
  assert.equal(report.handoff.evidenceReady, false);
});

test('blocks readiness when cohort runs do not match the matched ablation case count', () => {
  const cohorts = cohortResults();
  cohorts['exp-lead'].body.rows.parsedEvalV2Scores = 2;
  cohorts['exp-lead'].body.rows.decisionContextRows = 2;
  const report = buildResearchFinalizationReport({
    manifest: manifest(),
    ablationReport: ablationReport(),
    contextAudit: contextAudit(),
    cohortResults: cohorts,
  });

  assert.equal(report.integrity.allCohortRunCountsExact, false);
  assert.equal(report.status, 'BLOCKED_INCOMPLETE_RESEARCH_EVIDENCE');
});

test('formats a GPT handoff without promoting a strategy winner', () => {
  const report = buildResearchFinalizationReport({
    manifest: manifest(),
    ablationReport: ablationReport(),
    contextAudit: contextAudit(),
    cohortResults: cohortResults(),
  });
  const markdown = formatResearchFinalizationMarkdown(report);

  assert.match(markdown, /Decision mix by profile/);
  assert.match(markdown, /GPT handoff/);
  assert.match(markdown, /No scalar winner score/);
  assert.match(markdown, /does not activate live trading/i);
});
