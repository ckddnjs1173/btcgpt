export const RELAY_ENTRY_MAX_AGE_MS = 15_000;

export function applyRelayFreshness(
  source: Record<string, unknown>,
  generatedAt: number,
  receivedAt: number,
  now = Date.now(),
): Record<string, unknown> {
  const payload = structuredClone(source);
  const ageMs = Math.max(0, now - generatedAt);
  const originalGate =
    (payload.analysisGate as Record<string, unknown> | undefined) ?? {};
  payload.analysisGate = {
    ...originalGate,
    ageMs,
    publishedAt: receivedAt,
  };

  const originalDecisionGates = payload.decisionGates as
    | Record<string, unknown>
    | undefined;
  if (originalDecisionGates) {
    const criticalBlockers = [
      ...((originalDecisionGates.criticalBlockers as string[] | undefined) ?? []),
    ];
    const degradedSources = [
      ...((originalDecisionGates.degradedSources as string[] | undefined) ?? []),
    ];
    let marketAnalysisAvailable =
      originalDecisionGates.marketAnalysisAvailable === true;
    let entryAllowed = originalDecisionGates.entryAllowed === true;
    let positionManagementAvailable =
      originalDecisionGates.positionManagementAvailable === true;
    const storedQuality = originalDecisionGates.quality;
    let quality =
      storedQuality === 'GREEN' ||
      storedQuality === 'YELLOW' ||
      storedQuality === 'RED'
        ? storedQuality
        : 'RED';

    if (ageMs > 30_000) {
      marketAnalysisAvailable = false;
      entryAllowed = false;
      positionManagementAvailable = false;
      quality = 'RED';
      criticalBlockers.push('RELAY_SNAPSHOT_STALE');
    } else if (ageMs > RELAY_ENTRY_MAX_AGE_MS) {
      marketAnalysisAvailable = false;
      entryAllowed = false;
      quality = positionManagementAvailable ? 'YELLOW' : 'RED';
      criticalBlockers.push('RELAY_ENTRY_SNAPSHOT_STALE');
    } else if (ageMs > 8_000) {
      if (quality === 'GREEN') quality = 'YELLOW';
      degradedSources.push('relay:DELAYED');
    }

    payload.decisionGates = {
      ...originalDecisionGates,
      marketAnalysisAvailable,
      entryAllowed,
      positionManagementAvailable,
      quality,
      publishedAt: receivedAt,
      ageMs,
      relayPublishAgeMs: ageMs,
      criticalBlockers: [...new Set(criticalBlockers)],
      degradedSources: [...new Set(degradedSources)],
    };
  }

  if (ageMs > RELAY_ENTRY_MAX_AGE_MS) {
    payload.analysisGate = {
      ...(payload.analysisGate as Record<string, unknown>),
      analysisAllowed: false,
      overallStatus: 'STALE',
      ageMs,
      reasons: [
        ...((originalGate.reasons as string[] | undefined) ?? []),
        'RELAY_SNAPSHOT_STALE',
      ],
    };
  } else if (ageMs > 8_000 && originalGate.overallStatus === 'NORMAL') {
    payload.analysisGate = {
      ...(payload.analysisGate as Record<string, unknown>),
      overallStatus: 'DELAYED',
      reasons: [
        ...((originalGate.reasons as string[] | undefined) ?? []),
        'RELAY_SNAPSHOT_DELAYED',
      ],
    };
  }

  return payload;
}
