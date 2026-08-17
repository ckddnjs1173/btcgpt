const VALID_EVIDENCE_STATUSES = new Set([
  'NORMAL',
  'DEGRADED',
  'STALE',
  'UNAVAILABLE',
]);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value) {
  return typeof value === 'boolean' ? value : null;
}

function status(value) {
  return typeof value === 'string' && VALID_EVIDENCE_STATUSES.has(value)
    ? value
    : null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function payloadBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return null;
  }
}

function percentile(values, quantile) {
  const sorted = values
    .map(finite)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function distribution(values) {
  const numeric = values.map(finite).filter((value) => value !== null);
  if (numeric.length === 0) {
    return {
      count: 0,
      min: null,
      p50: null,
      p95: null,
      max: null,
      mean: null,
    };
  }
  return {
    count: numeric.length,
    min: Math.min(...numeric),
    p50: percentile(numeric, 0.5),
    p95: percentile(numeric, 0.95),
    max: Math.max(...numeric),
    mean: numeric.reduce((sum, value) => sum + value, 0) / numeric.length,
  };
}

function evidenceHealthRows(snapshot) {
  const evidence = record(snapshot?.evidence);
  return array(evidence?.auxiliaryEvidenceHealth).filter(record);
}

function healthCounts(rows) {
  const counts = {
    NORMAL: 0,
    DEGRADED: 0,
    STALE: 0,
    UNAVAILABLE: 0,
    UNKNOWN: 0,
  };
  for (const row of rows) {
    const value = status(row.status);
    if (value) counts[value] += 1;
    else counts.UNKNOWN += 1;
  }
  return counts;
}

function matchingHealth(rows, predicate) {
  return rows.filter((row) => predicate(String(row.sourceKey ?? '')));
}

function provenanceRows(value) {
  return array(record(value)?.provenance).filter(record);
}

function provenanceSummary(rows) {
  return {
    count: rows.length,
    statusCounts: healthCounts(rows),
    ageMs: distribution(rows.map((row) => row.ageMs)),
    collectorLagMs: distribution(rows.map((row) => row.collectorLagMs)),
    processingLagMs: distribution(rows.map((row) => row.processingLagMs)),
  };
}

function axisState(snapshot, healthRows) {
  const crypto = record(snapshot.cryptoMarket);
  const leadCore = record(crypto?.leadCore);
  const altMarket = record(crypto?.altMarket);
  const crossVenue = record(crypto?.crossVenue);
  const external = record(snapshot.external);
  const optionsV2 = record(external?.optionsV2);
  const onchainV1 = record(external?.onchainV1) ?? record(external?.onchain);

  const leadHealth = matchingHealth(healthRows, (key) =>
    /^lead:(ETHUSDT|SOLUSDT):/.test(key),
  );
  const altHealth = matchingHealth(healthRows, (key) => /^alt:/.test(key));
  const coinbaseHealth = matchingHealth(healthRows, (key) =>
    /^cross-venue:coinbase:/i.test(key),
  );

  return {
    leadCore: {
      available: Boolean(leadCore?.ETHUSDT) && Boolean(leadCore?.SOLUSDT),
      ethAvailable: Boolean(leadCore?.ETHUSDT),
      solAvailable: Boolean(leadCore?.SOLUSDT),
      generatedAt: finite(crypto?.generatedAt),
      healthCounts: healthCounts(leadHealth),
      healthRows: leadHealth.length,
    },
    altBreadth: {
      available: altMarket !== null,
      dynamicAssetCount: array(altMarket?.dynamic).length,
      basketMemberCount: array(altMarket?.basketMembers).length,
      generatedAt: finite(altMarket?.generatedAt),
      healthCounts: healthCounts(altHealth),
      healthRows: altHealth.length,
    },
    coinbase: {
      available: crossVenue !== null,
      generatedAt: finite(crossVenue?.generatedAt),
      healthCounts: healthCounts(coinbaseHealth),
      healthRows: coinbaseHealth.length,
      provenance: provenanceSummary(provenanceRows(crossVenue)),
    },
    optionsV2: {
      available: optionsV2 !== null,
      generatedAt: finite(optionsV2?.generatedAt),
      reportedAgeMs: finite(record(optionsV2?.health)?.ageMs),
      provenance: provenanceSummary(provenanceRows(optionsV2)),
    },
    onchainV1: {
      available: onchainV1 !== null,
      generatedAt: finite(onchainV1?.generatedAt),
      mempoolCollectionAgeMs: finite(
        record(onchainV1?.health)?.mempoolCollectionAgeMs,
      ),
      networkDailyCollectionAgeMs: finite(
        record(onchainV1?.health)?.networkDailyCollectionAgeMs,
      ),
      networkDailyPeriodAgeMs: finite(
        record(onchainV1?.health)?.networkDailyPeriodAgeMs,
      ),
      provenance: provenanceSummary(provenanceRows(onchainV1)),
    },
  };
}

function completenessMismatches(snapshot, axes) {
  const completeness = record(snapshot.completeness) ?? {};
  const actualLeadAssets =
    Number(axes.leadCore.ethAvailable) + Number(axes.leadCore.solAvailable);
  const actualDynamicAssets = axes.altBreadth.dynamicAssetCount;
  const actualCryptoAvailable = record(snapshot.cryptoMarket) !== null;
  const mismatches = [];

  if (
    typeof completeness.cryptoMarketAvailable === 'boolean' &&
    completeness.cryptoMarketAvailable !== actualCryptoAvailable
  ) {
    mismatches.push('CRYPTO_MARKET_AVAILABLE_MISMATCH');
  }
  if (
    finite(completeness.leadAssetsAvailable) !== null &&
    completeness.leadAssetsAvailable !== actualLeadAssets
  ) {
    mismatches.push('LEAD_ASSET_COUNT_MISMATCH');
  }
  if (
    finite(completeness.dynamicAssetCount) !== null &&
    completeness.dynamicAssetCount !== actualDynamicAssets
  ) {
    mismatches.push('DYNAMIC_ASSET_COUNT_MISMATCH');
  }

  return mismatches;
}

export function auditFrozenReplayInput(decisionId, replayInput) {
  const envelope = record(replayInput);
  const snapshot = record(envelope?.snapshot);
  const validDecisionContext = snapshot?.version === 'decision-context-v1';
  const healthRows = validDecisionContext ? evidenceHealthRows(snapshot) : [];
  const axes = validDecisionContext ? axisState(snapshot, healthRows) : null;
  const timing = validDecisionContext ? (record(snapshot.timing) ?? {}) : {};
  const gates = validDecisionContext
    ? (record(snapshot.decisionGates) ?? {})
    : {};
  const completeness = validDecisionContext
    ? (record(snapshot.completeness) ?? {})
    : {};

  return {
    decisionId,
    validDecisionContext,
    inputBasis: snapshot?.version ?? null,
    snapshotId: validDecisionContext ? (snapshot.snapshotId ?? null) : null,
    marketGeneratedAt: validDecisionContext
      ? finite(snapshot.marketGeneratedAt)
      : null,
    contextGeneratedAt: validDecisionContext
      ? finite(snapshot.generatedAt)
      : null,
    payloadBytes: payloadBytes(replayInput),
    decisionGate: validDecisionContext
      ? {
          quality: typeof gates.quality === 'string' ? gates.quality : null,
          marketAnalysisAvailable: bool(gates.marketAnalysisAvailable),
          entryAllowed: bool(gates.entryAllowed),
          positionManagementAvailable: bool(gates.positionManagementAvailable),
        }
      : null,
    timing: validDecisionContext
      ? {
          marketAgeMs: finite(timing.marketAgeMs),
          marketToRelayMs: finite(timing.marketToRelayMs),
          relayToActionStartMs: finite(timing.relayToActionStartMs),
          contextBuildMs: finite(timing.contextBuildMs),
          cryptoMarketAgeMs: finite(
            record(snapshot.evidence)?.cryptoMarketAgeMs,
          ),
        }
      : null,
    axes,
    health: validDecisionContext
      ? {
          counts: healthCounts(healthRows),
          rowCount: healthRows.length,
          sourceRows: healthRows.map((row) => ({
            sourceKey: typeof row.sourceKey === 'string' ? row.sourceKey : null,
            status: status(row.status) ?? 'UNKNOWN',
            ageMs: finite(row.ageMs),
            normalMaxAgeMs: finite(row.normalMaxAgeMs),
            usableMaxAgeMs: finite(row.usableMaxAgeMs),
            consecutiveFailures: finite(row.consecutiveFailures),
            reconnectCount: finite(row.reconnectCount),
          })),
        }
      : null,
    completeness: validDecisionContext
      ? {
          cryptoMarketAvailable:
            typeof completeness.cryptoMarketAvailable === 'boolean'
              ? completeness.cryptoMarketAvailable
              : null,
          leadAssetsAvailable: finite(completeness.leadAssetsAvailable),
          dynamicAssetCount: finite(completeness.dynamicAssetCount),
          mismatches: completenessMismatches(snapshot, axes),
        }
      : null,
  };
}

function axisAvailability(cases, axisName) {
  const valid = cases.filter((item) => item.validDecisionContext);
  const available = valid.filter(
    (item) => item.axes?.[axisName]?.available === true,
  );
  return {
    validCases: valid.length,
    availableCases: available.length,
    availabilityRate:
      valid.length === 0 ? null : available.length / valid.length,
  };
}

function aggregateSourceHealth(cases) {
  const bySource = new Map();
  for (const item of cases) {
    for (const row of item.health?.sourceRows ?? []) {
      const key = row.sourceKey ?? 'UNKNOWN_SOURCE';
      const current = bySource.get(key) ?? {
        sourceKey: key,
        observations: 0,
        NORMAL: 0,
        DEGRADED: 0,
        STALE: 0,
        UNAVAILABLE: 0,
        UNKNOWN: 0,
        ages: [],
      };
      current.observations += 1;
      current[row.status] += 1;
      if (row.ageMs !== null) current.ages.push(row.ageMs);
      bySource.set(key, current);
    }
  }
  return [...bySource.values()]
    .map((row) => ({
      sourceKey: row.sourceKey,
      observations: row.observations,
      statusCounts: {
        NORMAL: row.NORMAL,
        DEGRADED: row.DEGRADED,
        STALE: row.STALE,
        UNAVAILABLE: row.UNAVAILABLE,
        UNKNOWN: row.UNKNOWN,
      },
      nonNormalRate:
        row.observations === 0
          ? null
          : (row.DEGRADED + row.STALE + row.UNAVAILABLE + row.UNKNOWN) /
            row.observations,
      ageMs: distribution(row.ages),
    }))
    .sort((a, b) => {
      const rateDiff = (b.nonNormalRate ?? -1) - (a.nonNormalRate ?? -1);
      return rateDiff !== 0 ? rateDiff : b.observations - a.observations;
    });
}

export function buildFrozenContextAudit(caseAudits) {
  if (!Array.isArray(caseAudits) || caseAudits.length === 0) {
    throw new Error('FROZEN_CONTEXT_AUDIT_REQUIRES_CASES');
  }
  const validCases = caseAudits.filter((item) => item.validDecisionContext);
  const invalidCases = caseAudits.filter((item) => !item.validDecisionContext);
  const mismatchCases = validCases.filter(
    (item) => (item.completeness?.mismatches?.length ?? 0) > 0,
  );

  return {
    version: 'frozen-context-audit-v1',
    generatedAt: Date.now(),
    caseCount: caseAudits.length,
    validDecisionContextCases: validCases.length,
    invalidDecisionContextCases: invalidCases.length,
    validDecisionContextRate: validCases.length / caseAudits.length,
    payloadBytes: distribution(caseAudits.map((item) => item.payloadBytes)),
    timing: {
      marketAgeMs: distribution(
        validCases.map((item) => item.timing?.marketAgeMs),
      ),
      cryptoMarketAgeMs: distribution(
        validCases.map((item) => item.timing?.cryptoMarketAgeMs),
      ),
      marketToRelayMs: distribution(
        validCases.map((item) => item.timing?.marketToRelayMs),
      ),
      relayToActionStartMs: distribution(
        validCases.map((item) => item.timing?.relayToActionStartMs),
      ),
      contextBuildMs: distribution(
        validCases.map((item) => item.timing?.contextBuildMs),
      ),
    },
    gates: {
      quality: validCases.reduce((counts, item) => {
        const key = item.decisionGate?.quality ?? 'UNKNOWN';
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {}),
      entryAllowedCases: validCases.filter(
        (item) => item.decisionGate?.entryAllowed === true,
      ).length,
      marketAnalysisAvailableCases: validCases.filter(
        (item) => item.decisionGate?.marketAnalysisAvailable === true,
      ).length,
    },
    axes: {
      leadCore: axisAvailability(validCases, 'leadCore'),
      altBreadth: axisAvailability(validCases, 'altBreadth'),
      coinbase: axisAvailability(validCases, 'coinbase'),
      optionsV2: axisAvailability(validCases, 'optionsV2'),
      onchainV1: axisAvailability(validCases, 'onchainV1'),
    },
    health: {
      aggregateCounts: validCases.reduce(
        (counts, item) => {
          for (const key of [
            'NORMAL',
            'DEGRADED',
            'STALE',
            'UNAVAILABLE',
            'UNKNOWN',
          ]) {
            counts[key] += item.health?.counts?.[key] ?? 0;
          }
          return counts;
        },
        { NORMAL: 0, DEGRADED: 0, STALE: 0, UNAVAILABLE: 0, UNKNOWN: 0 },
      ),
      bySource: aggregateSourceHealth(validCases),
    },
    completeness: {
      mismatchCases: mismatchCases.length,
      mismatchRate:
        validCases.length === 0
          ? null
          : mismatchCases.length / validCases.length,
      mismatchDetails: mismatchCases.map((item) => ({
        decisionId: item.decisionId,
        mismatches: item.completeness.mismatches,
      })),
    },
    invalidCases: invalidCases.map((item) => ({
      decisionId: item.decisionId,
      inputBasis: item.inputBasis,
    })),
    cases: caseAudits,
    policy: {
      tradingSignal: false,
      automaticPromotion: false,
      note: 'This audit measures frozen-input availability, freshness metadata, payload size and contract consistency only. It does not judge trade direction or evidence usefulness.',
    },
  };
}

export function formatFrozenContextAuditMarkdown(report) {
  const number = (value, digits = 1) =>
    typeof value === 'number' && Number.isFinite(value)
      ? value.toFixed(digits)
      : 'n/a';
  const percent = (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? `${(value * 100).toFixed(1)}%`
      : 'n/a';
  const dist = (value) =>
    `p50 ${number(value.p50)} / p95 ${number(value.p95)} / max ${number(value.max)}`;

  const lines = [
    '# Frozen Decision Context Audit',
    '',
    `Cases: ${report.caseCount}`,
    `Valid decision-context-v1: ${report.validDecisionContextCases}/${report.caseCount} (${percent(report.validDecisionContextRate)})`,
    `Completeness metadata mismatches: ${report.completeness.mismatchCases}`,
    '',
    '## Payload and timing',
    '',
    `- Payload bytes: ${dist(report.payloadBytes)}`,
    `- Market age ms: ${dist(report.timing.marketAgeMs)}`,
    `- Crypto-market age ms: ${dist(report.timing.cryptoMarketAgeMs)}`,
    `- Market → relay ms: ${dist(report.timing.marketToRelayMs)}`,
    `- Relay → action start ms: ${dist(report.timing.relayToActionStartMs)}`,
    `- Context build ms: ${dist(report.timing.contextBuildMs)}`,
    '',
    '## Evidence availability',
    '',
    '| Axis | Available | Rate |',
    '| --- | ---: | ---: |',
  ];

  for (const [name, axis] of Object.entries(report.axes)) {
    lines.push(
      `| ${name} | ${axis.availableCases}/${axis.validCases} | ${percent(axis.availabilityRate)} |`,
    );
  }

  lines.push(
    '',
    '## Auxiliary source health',
    '',
    `- NORMAL: ${report.health.aggregateCounts.NORMAL}`,
    `- DEGRADED: ${report.health.aggregateCounts.DEGRADED}`,
    `- STALE: ${report.health.aggregateCounts.STALE}`,
    `- UNAVAILABLE: ${report.health.aggregateCounts.UNAVAILABLE}`,
    `- UNKNOWN: ${report.health.aggregateCounts.UNKNOWN}`,
    '',
    '| Source | Observations | Non-normal rate | Age p95 ms |',
    '| --- | ---: | ---: | ---: |',
  );

  for (const row of report.health.bySource.slice(0, 20)) {
    lines.push(
      `| ${row.sourceKey} | ${row.observations} | ${percent(row.nonNormalRate)} | ${number(row.ageMs.p95)} |`,
    );
  }

  lines.push(
    '',
    '## Interpretation boundary',
    '',
    '- Missing or stale evidence is reported as observed; it is never reconstructed from current data.',
    '- Payload size and latency are reported descriptively without inventing a pass/fail threshold.',
    '- Evidence availability does not mean the evidence improves trading decisions; use matched ablation results for that question.',
    '- This report never creates LONG/SHORT, ENTER/WAIT, sizing, leverage, or automatic promotion decisions.',
    '',
  );
  return lines.join('\n');
}
