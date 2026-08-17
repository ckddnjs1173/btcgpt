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

function normalizePathQuality(result) {
  const body = result?.ok === true ? result.body : null;
  if (!body || typeof body !== 'object') {
    return {
      status: 'UNAVAILABLE',
      errorStatus: result?.status ?? null,
      error: result?.body?.error ?? 'PATH_QUALITY_UNAVAILABLE',
      enter: null,
      wait: null,
      management: null,
    };
  }

  return {
    status: 'AVAILABLE',
    errorStatus: null,
    error: null,
    enter: {
      samples: finite(body.enter?.samples),
      meanMfeR: finite(body.enter?.mfeR?.mean),
      medianMfeR: finite(body.enter?.mfeR?.median),
      meanMaeR: finite(body.enter?.maeR?.mean),
      medianMaeR: finite(body.enter?.maeR?.median),
      meanInitialAdverseBps: finite(
        body.enter?.initialAdverseExcursionBps?.mean,
      ),
      meanTimeToMfeMs: finite(body.enter?.timeToMfeMs?.mean),
      meanTimeToMaeMs: finite(body.enter?.timeToMaeMs?.mean),
      tp1ResolvedSamples: finite(body.enter?.tp1Ordering?.resolvedSamples),
      tp1TargetFirstRate: finite(body.enter?.tp1Ordering?.targetFirstRate),
      tp1StopFirstRate: finite(body.enter?.tp1Ordering?.stopFirstRate),
      tp1AmbiguousRate: finite(body.enter?.tp1Ordering?.ambiguousRate),
    },
    wait: {
      samples: finite(body.wait?.samples),
      triggerHitRate: finite(body.wait?.triggerHitRate),
      invalidationBeforeTriggerRate: finite(
        body.wait?.invalidationBeforeTriggerRate,
      ),
      expiredWithoutTriggerRate: finite(body.wait?.expiredWithoutTriggerRate),
      meanTimeToTriggerMs: finite(body.wait?.timeToTriggerMs?.mean),
      chaseSamples: finite(body.wait?.chase?.samples),
      maxChaseExceededRate: finite(body.wait?.chase?.maxChaseExceededRate),
      meanPostTriggerFavorableBps: finite(
        body.wait?.postTrigger15m?.favorableBps?.mean,
      ),
      meanPostTriggerAdverseBps: finite(
        body.wait?.postTrigger15m?.adverseBps?.mean,
      ),
    },
    management: {
      samples: finite(body.management?.samples),
      meanFavorable30mBps: finite(body.management?.favorable30mBps?.mean),
      meanAdverse30mBps: finite(body.management?.adverse30mBps?.mean),
    },
  };
}

function normalizeBenchmark(profile, result, pathQualityResult, expectedCaseCount) {
  const pathQuality = normalizePathQuality(pathQualityResult);
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
      pathQuality,
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
    pathQuality,
  };
}

function pathDeltas(before, after) {
  return {
    enter: {
      samples: subtract(after.enter?.samples, before.enter?.samples),
      meanMfeR: subtract(after.enter?.meanMfeR, before.enter?.meanMfeR),
      meanMaeR: subtract(after.enter?.meanMaeR, before.enter?.meanMaeR),
      meanInitialAdverseBps: subtract(
        after.enter?.meanInitialAdverseBps,
        before.enter?.meanInitialAdverseBps,
      ),
      tp1TargetFirstRate: subtract(
        after.enter?.tp1TargetFirstRate,
        before.enter?.tp1TargetFirstRate,
      ),
      tp1StopFirstRate: subtract(
        after.enter?.tp1StopFirstRate,
        before.enter?.tp1StopFirstRate,
      ),
    },
    wait: {
      samples: subtract(after.wait?.samples, before.wait?.samples),
      triggerHitRate: subtract(
        after.wait?.triggerHitRate,
        before.wait?.triggerHitRate,
      ),
      invalidationBeforeTriggerRate: subtract(
        after.wait?.invalidationBeforeTriggerRate,
        before.wait?.invalidationBeforeTriggerRate,
      ),
      expiredWithoutTriggerRate: subtract(
        after.wait?.expiredWithoutTriggerRate,
        before.wait?.expiredWithoutTriggerRate,
      ),
      maxChaseExceededRate: subtract(
        after.wait?.maxChaseExceededRate,
        before.wait?.maxChaseExceededRate,
      ),
      meanPostTriggerFavorableBps: subtract(
        after.wait?.meanPostTriggerFavorableBps,
        before.wait?.meanPostTriggerFavorableBps,
      ),
      meanPostTriggerAdverseBps: subtract(
        after.wait?.meanPostTriggerAdverseBps,
        before.wait?.meanPostTriggerAdverseBps,
      ),
    },
    management: {
      samples: subtract(
        after.management?.samples,
        before.management?.samples,
      ),
      meanFavorable30mBps: subtract(
        after.management?.meanFavorable30mBps,
        before.management?.meanFavorable30mBps,
      ),
      meanAdverse30mBps: subtract(
        after.management?.meanAdverse30mBps,
        before.management?.meanAdverse30mBps,
      ),
    },
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
  const pathComparable =
    comparable &&
    before.pathQuality.status === 'AVAILABLE' &&
    after.pathQuality.status === 'AVAILABLE';

  return {
    from: before.profile,
    to: after.profile,
    addedSources: (after.enabledSources ?? []).filter(
      (source) => !(before.enabledSources ?? []).includes(source),
    ),
    comparable,
    pathComparable,
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
    pathDeltas: pathComparable
      ? pathDeltas(before.pathQuality, after.pathQuality)
      : null,
  };
}

export function buildEvidenceAblationReport(
  manifest,
  benchmarkResults,
  pathQualityResults = {},
) {
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
      pathQualityResults?.[profile.experimentId],
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
  const pathQualityProfilesAvailable = profiles.filter(
    (profile) => profile.pathQuality.status === 'AVAILABLE',
  ).length;

  return {
    version: 'evidence-ablation-report-v2',
    generatedAt: Date.now(),
    sourceExperimentId: manifest.sourceExperimentId ?? null,
    expectedCaseCount,
    profileCount: profiles.length,
    selectionInvariant: manifest.selectionInvariant === true,
    integrity: {
      allProfilesAvailable,
      allProfilesExactCaseCount,
      allAdjacentComparable,
      pathQualityProfilesAvailable,
      allPathQualityProfilesAvailable:
        pathQualityProfilesAvailable === profiles.length,
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
      note: 'Adjacent deltas are descriptive evidence only. ENTER, WAIT_TRIGGER and position-management path vectors remain separate. Review sample sufficiency, multiple market regimes, latency, cost, missed opportunity and out-of-sample behavior before any live candidate decision.',
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
    `Path-quality profiles available: ${report.integrity.pathQualityProfilesAvailable}/${report.profileCount}`,
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
    '## ENTER path quality',
    '',
    '| Profile | ENTER samples | Mean MFE R | Mean MAE R | Initial adverse bps | TP1 target-first | TP1 stop-first |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const profile of report.profiles) {
    const enter = profile.pathQuality.enter;
    lines.push(
      `| ${profile.profile} | ${enter?.samples ?? 'n/a'} | ${format(enter?.meanMfeR)} | ${format(enter?.meanMaeR)} | ${format(enter?.meanInitialAdverseBps)} | ${percent(enter?.tp1TargetFirstRate)} | ${percent(enter?.tp1StopFirstRate)} |`,
    );
  }

  lines.push(
    '',
    '## WAIT_TRIGGER path quality',
    '',
    '| Profile | WAIT samples | Trigger hit | Invalidated first | Expired | Chase exceeded | Post-trigger favorable bps | Post-trigger adverse bps |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const profile of report.profiles) {
    const wait = profile.pathQuality.wait;
    lines.push(
      `| ${profile.profile} | ${wait?.samples ?? 'n/a'} | ${percent(wait?.triggerHitRate)} | ${percent(wait?.invalidationBeforeTriggerRate)} | ${percent(wait?.expiredWithoutTriggerRate)} | ${percent(wait?.maxChaseExceededRate)} | ${format(wait?.meanPostTriggerFavorableBps)} | ${format(wait?.meanPostTriggerAdverseBps)} |`,
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
    '## Adjacent path-quality deltas',
    '',
    '> Path deltas are conditional on each profile’s own decision class samples. A changed ENTER/WAIT mix can change these samples, so these vectors are descriptive rather than a causal source score.',
    '',
    '| Comparison | Path comparable | MFE R Δ | MAE R Δ | TP1 target-first Δ | WAIT trigger-hit Δ | WAIT invalidated-first Δ | WAIT chase-exceeded Δ |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const comparison of report.adjacentComparisons) {
    const path = comparison.pathDeltas;
    lines.push(
      `| ${comparison.from} → ${comparison.to} | ${comparison.pathComparable} | ${format(path?.enter?.meanMfeR)} | ${format(path?.enter?.meanMaeR)} | ${percent(path?.enter?.tp1TargetFirstRate)} | ${percent(path?.wait?.triggerHitRate)} | ${percent(path?.wait?.invalidationBeforeTriggerRate)} | ${percent(path?.wait?.maxChaseExceededRate)} |`,
    );
  }

  lines.push(
    '',
    '## Interpretation boundary',
    '',
    '- This report does not select a winner or promote a profile automatically.',
    '- Compare adjacent profiles first because each step adds one approved evidence axis.',
    '- Treat directional accuracy, signed return, abstain opportunity, ENTER path quality, WAIT trigger quality, management quality, latency and cost as separate evidence vectors rather than one strategy score.',
    '- Path-quality deltas are conditional on the decisions each profile actually made and must not be interpreted as isolated causal effects by themselves.',
    '- Require sufficient matched samples, multiple regimes and out-of-sample review before `LIVE_CANDIDATE` consideration.',
    '',
  );

  return lines.join('\n');
}
