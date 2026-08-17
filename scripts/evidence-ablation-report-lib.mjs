function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function subtract(after, before) {
  const a = finite(after);
  const b = finite(before);
  return a === null || b === null ? null : a - b;
}

function divide(numerator, denominator) {
  const a = finite(numerator);
  const b = finite(denominator);
  return a === null || b === null || b === 0 ? null : a / b;
}

function normalizeBenchmark(profile, result, expectedCaseCount) {
  const body = result?.ok === true ? result.body : null;
  if (!body || typeof body !== 'object') {
    return {
      ...profile,
      status: 'UNAVAILABLE',
      errorStatus: result?.status ?? null,
      error: result?.body?.error ?? 'BENCHMARK_UNAVAILABLE',
      matchedCases: null,
      expectedCaseCount,
      exactCaseCount: false,
      directionalSamples: null,
      directionalAccuracy: null,
      averageSignedReturnBps30m: null,
      abstainSamples: null,
      averageAbstainOpportunityBps30m: null,
      averageLatencyMs: null,
      totalReportedCostUsd: null,
      costPerMatchedCaseUsd: null,
      promotionEvidenceStatus: null,
    };
  }

  const matchedCases = finite(body.matchedCases);
  const totalCost = finite(body.operational?.apiTotalReportedCostUsd);
  return {
    ...profile,
    status: 'AVAILABLE',
    errorStatus: null,
    error: null,
    matchedCases,
    expectedCaseCount,
    exactCaseCount:
      matchedCases !== null && matchedCases === finite(expectedCaseCount),
    directionalSamples: finite(body.api?.directionalSamples),
    directionalAccuracy: finite(body.api?.correctRate),
    averageSignedReturnBps30m: finite(body.api?.averageSignedReturnBps30m),
    abstainSamples: finite(body.api?.abstainSamples),
    averageAbstainOpportunityBps30m: finite(
      body.api?.averageAbstainOpportunityBps30m,
    ),
    averageLatencyMs: finite(body.operational?.apiAverageLatencyMs),
    totalReportedCostUsd: totalCost,
    costPerMatchedCaseUsd: divide(totalCost, matchedCases),
    promotionEvidenceStatus: body.promotionEvidence?.status ?? null,
  };
}

function compareAdjacent(before, after) {
  const sameMatchedCases =
    before.matchedCases !== null &&
    after.matchedCases !== null &&
    before.matchedCases === after.matchedCases;
  const comparable =
    before.status === 'AVAILABLE' &&
    after.status === 'AVAILABLE' &&
    sameMatchedCases &&
    before.exactCaseCount &&
    after.exactCaseCount;

  return {
    from: before.profile,
    to: after.profile,
    addedSources: (after.enabledSources ?? []).filter(
      (source) => !(before.enabledSources ?? []).includes(source),
    ),
    comparable,
    integrity: {
      sameMatchedCases,
      fromExactCaseCount: before.exactCaseCount,
      toExactCaseCount: after.exactCaseCount,
    },
    deltas: {
      matchedCases: subtract(after.matchedCases, before.matchedCases),
      directionalSamples: subtract(
        after.directionalSamples,
        before.directionalSamples,
      ),
      directionalAccuracy: subtract(
        after.directionalAccuracy,
        before.directionalAccuracy,
      ),
      averageSignedReturnBps30m: subtract(
        after.averageSignedReturnBps30m,
        before.averageSignedReturnBps30m,
      ),
      abstainSamples: subtract(after.abstainSamples, before.abstainSamples),
      averageAbstainOpportunityBps30m: subtract(
        after.averageAbstainOpportunityBps30m,
        before.averageAbstainOpportunityBps30m,
      ),
      averageLatencyMs: subtract(
        after.averageLatencyMs,
        before.averageLatencyMs,
      ),
      totalReportedCostUsd: subtract(
        after.totalReportedCostUsd,
        before.totalReportedCostUsd,
      ),
      costPerMatchedCaseUsd: subtract(
        after.costPerMatchedCaseUsd,
        before.costPerMatchedCaseUsd,
      ),
    },
  };
}

export function buildEvidenceAblationReport(manifest, benchmarkResults) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('INVALID_ABLATION_MANIFEST');
  }
  if (!Array.isArray(manifest.profiles) || manifest.profiles.length < 2) {
    throw new Error('ABLATION_MANIFEST_REQUIRES_MULTIPLE_PROFILES');
  }

  const expectedCaseCount = finite(manifest.caseCount);
  const orderedProfiles = [...manifest.profiles].sort(
    (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0),
  );
  const profiles = orderedProfiles.map((profile) =>
    normalizeBenchmark(
      profile,
      benchmarkResults?.[profile.experimentId],
      expectedCaseCount,
    ),
  );
  const comparisons = [];
  for (let index = 1; index < profiles.length; index += 1) {
    comparisons.push(compareAdjacent(profiles[index - 1], profiles[index]));
  }

  const allProfilesAvailable = profiles.every(
    (profile) => profile.status === 'AVAILABLE',
  );
  const allProfilesExactCaseCount = profiles.every(
    (profile) => profile.exactCaseCount,
  );
  const allAdjacentComparable = comparisons.every(
    (comparison) => comparison.comparable,
  );

  return {
    version: 'evidence-ablation-report-v1',
    generatedAt: Date.now(),
    sourceExperimentId: manifest.sourceExperimentId ?? null,
    expectedCaseCount,
    profileCount: profiles.length,
    selectionInvariant: manifest.selectionInvariant === true,
    integrity: {
      allProfilesAvailable,
      allProfilesExactCaseCount,
      allAdjacentComparable,
      validForManualComparison:
        manifest.selectionInvariant === true &&
        allProfilesAvailable &&
        allProfilesExactCaseCount &&
        allAdjacentComparable,
    },
    profiles,
    adjacentComparisons: comparisons,
    policy: {
      automaticPromotion: false,
      scalarWinnerScore: false,
      note: 'Adjacent deltas are descriptive evidence only. Review sample sufficiency, multiple market regimes, latency, cost, missed opportunity and out-of-sample behavior before any live candidate decision.',
    },
  };
}

export function formatEvidenceAblationMarkdown(report) {
  const format = (value, digits = 3) =>
    typeof value === 'number' && Number.isFinite(value)
      ? value.toFixed(digits)
      : 'n/a';
  const percent = (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? `${(value * 100).toFixed(2)}%`
      : 'n/a';

  const lines = [
    '# Evidence Ablation Report',
    '',
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    `Source experiment: ${report.sourceExperimentId ?? 'n/a'}`,
    `Expected frozen cases per profile: ${report.expectedCaseCount ?? 'n/a'}`,
    `Valid for manual comparison: ${report.integrity.validForManualComparison}`,
    '',
    '## Profile metrics',
    '',
    '| Profile | Cases | Directional samples | Accuracy | Avg signed return 30m (bps) | Abstain samples | Avg abstain opportunity 30m (bps) | Avg latency (ms) | Cost / case (USD) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const profile of report.profiles) {
    lines.push(
      `| ${profile.profile} | ${profile.matchedCases ?? 'n/a'} | ${profile.directionalSamples ?? 'n/a'} | ${percent(profile.directionalAccuracy)} | ${format(profile.averageSignedReturnBps30m)} | ${profile.abstainSamples ?? 'n/a'} | ${format(profile.averageAbstainOpportunityBps30m)} | ${format(profile.averageLatencyMs, 1)} | ${format(profile.costPerMatchedCaseUsd, 6)} |`,
    );
  }

  lines.push(
    '',
    '## Adjacent evidence deltas',
    '',
    '> Positive signed-return delta means the later profile had higher average 30m signed return. Positive abstain-opportunity delta means more opportunity remained after WAIT/NO_TRADE and is not automatically favorable. Negative latency/cost deltas mean the later profile was faster/cheaper.',
    '',
    '| Comparison | Added source | Comparable | Accuracy Δ | Signed return Δ (bps) | Abstain opportunity Δ (bps) | Latency Δ (ms) | Cost/case Δ (USD) |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  );

  for (const comparison of report.adjacentComparisons) {
    lines.push(
      `| ${comparison.from} → ${comparison.to} | ${comparison.addedSources.join(', ') || 'none'} | ${comparison.comparable} | ${percent(comparison.deltas.directionalAccuracy)} | ${format(comparison.deltas.averageSignedReturnBps30m)} | ${format(comparison.deltas.averageAbstainOpportunityBps30m)} | ${format(comparison.deltas.averageLatencyMs, 1)} | ${format(comparison.deltas.costPerMatchedCaseUsd, 6)} |`,
    );
  }

  lines.push(
    '',
    '## Interpretation boundary',
    '',
    '- This report does not select a winner or promote a profile automatically.',
    '- Compare adjacent profiles first because each step adds one approved evidence axis.',
    '- Treat directional accuracy, signed return, abstain opportunity, latency and cost as separate evidence vectors rather than one strategy score.',
    '- Require sufficient matched samples, multiple regimes and out-of-sample review before `LIVE_CANDIDATE` consideration.',
    '',
  );

  return lines.join('\n');
}
