const DECISION_KEYS = [
  'ENTER',
  'WAIT',
  'ABSTAIN',
  'DATA_BLOCKED',
  'POSITION_MANAGEMENT',
];

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function subtract(after, before) {
  const a = finite(after);
  const b = finite(before);
  return a === null || b === null ? null : a - b;
}

function normalizeDecisionMix(value) {
  const source = value && typeof value === 'object' ? value : {};
  const counts =
    source.counts && typeof source.counts === 'object' ? source.counts : {};
  const rates =
    source.rates && typeof source.rates === 'object' ? source.rates : {};
  return {
    samples: finite(source.samples),
    counts: Object.fromEntries(
      DECISION_KEYS.map((key) => [key, finite(counts[key])]),
    ),
    rates: Object.fromEntries(
      DECISION_KEYS.map((key) => [key, finite(rates[key])]),
    ),
  };
}

function normalizeCohortResult(profile, result, matchedCases) {
  const body = result?.ok === true ? result.body : null;
  if (!body || typeof body !== 'object') {
    return {
      profile: profile.profile,
      experimentId: profile.experimentId,
      status: 'UNAVAILABLE',
      errorStatus: result?.status ?? null,
      error: result?.body?.error ?? 'DECISION_COHORTS_UNAVAILABLE',
      matchedCases,
      parsedEvalV2Scores: null,
      exactScoredRunCount: false,
      invalidScorePayloads: null,
      invalidSnapshotPayloads: null,
      decisionContextRows: null,
      allRowsDecisionContext: false,
      decisionMix: normalizeDecisionMix(null),
      regimeDefinition: null,
      completenessCohorts: [],
      regimeCohorts: [],
    };
  }

  const parsedEvalV2Scores = finite(body.rows?.parsedEvalV2Scores);
  const decisionContextRows = finite(body.rows?.decisionContextRows);
  return {
    profile: profile.profile,
    experimentId: profile.experimentId,
    status: 'AVAILABLE',
    errorStatus: null,
    error: null,
    matchedCases,
    parsedEvalV2Scores,
    exactScoredRunCount:
      matchedCases !== null && parsedEvalV2Scores === matchedCases,
    invalidScorePayloads: finite(body.rows?.invalidScorePayloads),
    invalidSnapshotPayloads: finite(body.rows?.invalidSnapshotPayloads),
    decisionContextRows,
    allRowsDecisionContext:
      parsedEvalV2Scores !== null && decisionContextRows === parsedEvalV2Scores,
    decisionMix: normalizeDecisionMix(body.decisionMix),
    regimeDefinition:
      body.regimeDefinition && typeof body.regimeDefinition === 'object'
        ? body.regimeDefinition
        : null,
    completenessCohorts: Array.isArray(body.completenessCohorts)
      ? body.completenessCohorts
      : [],
    regimeCohorts: Array.isArray(body.regimeCohorts) ? body.regimeCohorts : [],
  };
}

function regimeSignature(profile) {
  const definition = profile.regimeDefinition;
  if (!definition) return null;
  return JSON.stringify({
    volatilityFeature: definition.volatilityFeature ?? null,
    volatilityMethod: definition.volatilityMethod ?? null,
    lowerTercile: finite(definition.lowerTercile),
    upperTercile: finite(definition.upperTercile),
    thresholdCaseSamples: finite(definition.thresholdCaseSamples),
    returnFeature: definition.returnFeature ?? null,
    returnMethod: definition.returnMethod ?? null,
  });
}

function decisionMixDeltas(before, after) {
  return Object.fromEntries(
    DECISION_KEYS.map((key) => [
      key,
      subtract(after.decisionMix.rates[key], before.decisionMix.rates[key]),
    ]),
  );
}

export function buildResearchFinalizationReport({
  manifest,
  ablationReport,
  contextAudit,
  cohortResults,
}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('INVALID_RESEARCH_FINALIZATION_MANIFEST');
  }
  if (!ablationReport || typeof ablationReport !== 'object') {
    throw new Error('ABLATION_REPORT_REQUIRED');
  }
  if (!contextAudit || typeof contextAudit !== 'object') {
    throw new Error('CONTEXT_AUDIT_REQUIRED');
  }

  const expectedCaseCount = finite(manifest.caseCount);
  const orderedProfiles = [...(manifest.profiles ?? [])].sort(
    (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0),
  );
  if (orderedProfiles.length < 2) {
    throw new Error('RESEARCH_FINALIZATION_REQUIRES_MULTIPLE_PROFILES');
  }

  const matchedByExperiment = new Map(
    (ablationReport.profiles ?? []).map((profile) => [
      profile.experimentId,
      finite(profile.matchedCases),
    ]),
  );
  const profiles = orderedProfiles.map((profile) =>
    normalizeCohortResult(
      profile,
      cohortResults?.[profile.experimentId],
      matchedByExperiment.get(profile.experimentId) ?? null,
    ),
  );

  const comparisons = [];
  for (let index = 1; index < profiles.length; index += 1) {
    const before = profiles[index - 1];
    const after = profiles[index];
    const comparable =
      before.status === 'AVAILABLE' &&
      after.status === 'AVAILABLE' &&
      before.exactScoredRunCount &&
      after.exactScoredRunCount;
    comparisons.push({
      from: before.profile,
      to: after.profile,
      comparable,
      decisionMixRateDeltas: comparable
        ? decisionMixDeltas(before, after)
        : null,
    });
  }

  const availableProfiles = profiles.filter(
    (profile) => profile.status === 'AVAILABLE',
  );
  const regimeSignatures = new Set(
    availableProfiles.map(regimeSignature).filter((value) => value !== null),
  );
  const allCohortProfilesAvailable =
    availableProfiles.length === profiles.length;
  const allCohortRunCountsExact = profiles.every(
    (profile) => profile.exactScoredRunCount,
  );
  const allCohortRowsDecisionContext = profiles.every(
    (profile) => profile.allRowsDecisionContext,
  );
  const noCohortParseErrors = profiles.every(
    (profile) =>
      profile.invalidScorePayloads === 0 &&
      profile.invalidSnapshotPayloads === 0,
  );
  const regimeDefinitionsAligned =
    allCohortProfilesAvailable && regimeSignatures.size === 1;

  const contextAuditComplete =
    expectedCaseCount !== null &&
    contextAudit.caseCount === expectedCaseCount &&
    contextAudit.validDecisionContextCases === expectedCaseCount &&
    contextAudit.invalidDecisionContextCases === 0 &&
    contextAudit.completeness?.mismatchCases === 0;
  const ablationComparable =
    ablationReport.integrity?.validForManualComparison === true;
  const allPathQualityProfilesAvailable =
    ablationReport.integrity?.allPathQualityProfilesAvailable === true;

  const readyForManualResearchReview =
    contextAuditComplete &&
    ablationComparable &&
    allPathQualityProfilesAvailable &&
    allCohortProfilesAvailable &&
    allCohortRunCountsExact &&
    allCohortRowsDecisionContext &&
    noCohortParseErrors &&
    regimeDefinitionsAligned;

  return {
    version: 'research-finalization-v1',
    generatedAt: Date.now(),
    sourceExperimentId: manifest.sourceExperimentId ?? null,
    expectedCaseCount,
    profileCount: profiles.length,
    status: readyForManualResearchReview
      ? 'READY_FOR_MANUAL_RESEARCH_REVIEW'
      : 'BLOCKED_INCOMPLETE_RESEARCH_EVIDENCE',
    integrity: {
      contextAuditComplete,
      ablationComparable,
      allPathQualityProfilesAvailable,
      allCohortProfilesAvailable,
      allCohortRunCountsExact,
      allCohortRowsDecisionContext,
      noCohortParseErrors,
      regimeDefinitionsAligned,
      readyForManualResearchReview,
    },
    profiles,
    adjacentComparisons: comparisons,
    contextAudit,
    ablationReport,
    handoff: {
      nextStage: 'GPT_INSTRUCTION_ITERATION',
      toolingReady: true,
      evidenceReady: readyForManualResearchReview,
      liveCandidateStatus: 'NOT_EVALUATED_BY_THIS_REPORT',
    },
    policy: {
      automaticPromotion: false,
      scalarWinnerScore: false,
      liveActivation: false,
      note: 'This report closes the research instrumentation loop only. It may authorize manual review of matched evidence; it never promotes a source/model, creates a LONG/SHORT rule, or activates live trading automatically.',
    },
  };
}

export function formatResearchFinalizationMarkdown(report) {
  const percent = (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? `${(value * 100).toFixed(2)}%`
      : 'n/a';
  const signedPercent = (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}pp`
      : 'n/a';

  const lines = [
    '# Research Finalization Report',
    '',
    `Status: **${report.status}**`,
    `Expected frozen cases: ${report.expectedCaseCount ?? 'n/a'}`,
    `Profiles: ${report.profileCount}`,
    '',
    '## Integrity gates',
    '',
    `- Frozen Decision Context audit complete: ${report.integrity.contextAuditComplete}`,
    `- Matched ablation comparable: ${report.integrity.ablationComparable}`,
    `- Eval V2 path quality available for every profile: ${report.integrity.allPathQualityProfilesAvailable}`,
    `- Decision cohort profile coverage complete: ${report.integrity.allCohortProfilesAvailable}`,
    `- Cohort scored-run counts match ablation cases: ${report.integrity.allCohortRunCountsExact}`,
    `- Every cohort row uses decision-context-v1: ${report.integrity.allCohortRowsDecisionContext}`,
    `- Cohort parse errors absent: ${report.integrity.noCohortParseErrors}`,
    `- Regime definitions aligned across matched profiles: ${report.integrity.regimeDefinitionsAligned}`,
    '',
    '## Decision mix by profile',
    '',
    '| Profile | Samples | ENTER | WAIT | NO_TRADE | DATA_BLOCKED | Management | Regime cohorts | Completeness cohorts |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const profile of report.profiles) {
    lines.push(
      `| ${profile.profile} | ${profile.decisionMix.samples ?? 'n/a'} | ${percent(profile.decisionMix.rates.ENTER)} | ${percent(profile.decisionMix.rates.WAIT)} | ${percent(profile.decisionMix.rates.ABSTAIN)} | ${percent(profile.decisionMix.rates.DATA_BLOCKED)} | ${percent(profile.decisionMix.rates.POSITION_MANAGEMENT)} | ${profile.regimeCohorts.length} | ${profile.completenessCohorts.length} |`,
    );
  }

  lines.push(
    '',
    '## Adjacent decision-mix deltas',
    '',
    '> Deltas are percentage-point changes in the decisions the model actually made on the same frozen cases. They are a confounder check for path-quality changes, not a quality score by themselves.',
    '',
    '| Comparison | Comparable | ENTER Δ | WAIT Δ | NO_TRADE Δ | DATA_BLOCKED Δ | Management Δ |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const comparison of report.adjacentComparisons) {
    const delta = comparison.decisionMixRateDeltas;
    lines.push(
      `| ${comparison.from} → ${comparison.to} | ${comparison.comparable} | ${signedPercent(delta?.ENTER)} | ${signedPercent(delta?.WAIT)} | ${signedPercent(delta?.ABSTAIN)} | ${signedPercent(delta?.DATA_BLOCKED)} | ${signedPercent(delta?.POSITION_MANAGEMENT)} |`,
    );
  }

  lines.push(
    '',
    '## GPT handoff',
    '',
    `- Next stage: ${report.handoff.nextStage}`,
    `- Research tooling ready: ${report.handoff.toolingReady}`,
    `- Current evidence ready for manual review: ${report.handoff.evidenceReady}`,
    '- Use regime/completeness cohorts to explain where instruction changes alter ENTER/WAIT/NO_TRADE behavior before interpreting MFE/MAE deltas.',
    '- Keep latency, cost, missed opportunity, decision mix, ENTER path, WAIT trigger quality and management quality as separate evidence vectors.',
    '',
    '## Interpretation boundary',
    '',
    '- No scalar winner score is produced.',
    '- No source, model or prompt is promoted automatically.',
    '- Relative volatility cohorts are empirical terciles of the same frozen case set and are not bullish/bearish labels.',
    '- This report does not create a local LONG/SHORT engine and does not activate live trading.',
    '',
  );

  return lines.join('\n');
}
