export const EVIDENCE_ABLATION_PROFILES = [
  'BASELINE',
  'LEAD_CORE',
  'ALT_BREADTH',
  'COINBASE',
  'OPTIONS_V2',
  'ONCHAIN_V1',
];

function clone(value) {
  return structuredClone(value);
}

function sourceKey(row) {
  return typeof row?.sourceKey === 'string' ? row.sourceKey : '';
}

function provenanceKey(row) {
  return [row?.source, row?.venue, row?.instrument]
    .filter((value) => typeof value === 'string')
    .join('|');
}

function keepLeadHealth(row) {
  return /^lead:(ETHUSDT|SOLUSDT):/.test(sourceKey(row));
}

function keepAltHealth(row) {
  return /^alt:/.test(sourceKey(row));
}

function keepCoinbaseHealth(row) {
  return /^cross-venue:coinbase:/.test(sourceKey(row));
}

function keepLeadProvenance(row) {
  return /ETHUSDT|SOLUSDT/.test(provenanceKey(row));
}

function keepAltProvenance(row) {
  const key = provenanceKey(row);
  return /BINANCE_USDM_ALT|SENTIMENT_CORE|DYNAMIC/.test(key);
}

function keepCoinbaseProvenance(row) {
  return /COINBASE/.test(provenanceKey(row));
}

function profileRank(profile) {
  const index = EVIDENCE_ABLATION_PROFILES.indexOf(profile);
  if (index < 0)
    throw new Error(`Unknown evidence ablation profile: ${profile}`);
  return index;
}

function compactCryptoMarket(cryptoMarket, rank) {
  if (!cryptoMarket || typeof cryptoMarket !== 'object') return null;
  if (rank < 1) return null;

  const output = clone(cryptoMarket);
  if (rank < 2) output.altMarket = null;
  if (rank < 3) output.crossVenue = null;

  const health = Array.isArray(output.evidenceHealth)
    ? output.evidenceHealth
    : [];
  output.evidenceHealth = health.filter((row) => {
    if (keepLeadHealth(row)) return true;
    if (rank >= 2 && keepAltHealth(row)) return true;
    if (rank >= 3 && keepCoinbaseHealth(row)) return true;
    return false;
  });

  const provenance = Array.isArray(output.provenance) ? output.provenance : [];
  output.provenance = provenance.filter((row) => {
    if (keepLeadProvenance(row)) return true;
    if (rank >= 2 && keepAltProvenance(row)) return true;
    if (rank >= 3 && keepCoinbaseProvenance(row)) return true;
    return false;
  });

  return output;
}

function compactExternal(external, rank) {
  if (!external || typeof external !== 'object') return external ?? null;
  const output = clone(external);
  if (rank < 4 && 'optionsV2' in output) output.optionsV2 = null;
  if (rank < 5) {
    if ('onchainV1' in output) output.onchainV1 = null;
    if ('onchain' in output) output.onchain = null;
  }
  return output;
}

function compactEvidence(evidence, cryptoMarket) {
  if (!evidence || typeof evidence !== 'object') return evidence ?? null;
  const output = clone(evidence);
  output.cryptoMarketAvailable = cryptoMarket !== null;
  output.cryptoMarketGeneratedAt = cryptoMarket?.generatedAt ?? null;
  output.cryptoMarketAgeMs =
    cryptoMarket === null ? null : (output.cryptoMarketAgeMs ?? null);
  output.auxiliaryEvidenceHealth = cryptoMarket?.evidenceHealth ?? [];
  output.provenance = cryptoMarket?.provenance ?? [];
  return output;
}

function compactCompleteness(completeness, cryptoMarket) {
  if (!completeness || typeof completeness !== 'object')
    return completeness ?? null;
  const output = clone(completeness);
  output.cryptoMarketAvailable = cryptoMarket !== null;
  output.leadAssetsAvailable = cryptoMarket
    ? [cryptoMarket.leadCore?.ETHUSDT, cryptoMarket.leadCore?.SOLUSDT].filter(
        (value) => value !== null && value !== undefined,
      ).length
    : 0;
  output.dynamicAssetCount = cryptoMarket?.altMarket?.dynamic?.length ?? 0;
  return output;
}

export function applyEvidenceAblation(replayInput, profile) {
  const rank = profileRank(profile);
  const output = clone(replayInput);
  const snapshot = output?.snapshot;

  // Legacy MARKET_SNAPSHOT replay cases do not carry decision-context evidence.
  // Preserve them byte-for-byte rather than pretending an ablation was applied.
  if (!snapshot || snapshot.version !== 'decision-context-v1') {
    return {
      replayInput: output,
      applied: false,
      profile,
      reason: 'DECISION_CONTEXT_REQUIRED',
    };
  }

  const cryptoMarket = compactCryptoMarket(snapshot.cryptoMarket, rank);
  snapshot.cryptoMarket = cryptoMarket;
  snapshot.external = compactExternal(snapshot.external, rank);
  snapshot.evidence = compactEvidence(snapshot.evidence, cryptoMarket);
  snapshot.completeness = compactCompleteness(
    snapshot.completeness,
    cryptoMarket,
  );

  return {
    replayInput: output,
    applied: true,
    profile,
    reason: null,
  };
}
