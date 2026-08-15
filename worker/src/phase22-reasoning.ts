import type { CrossMarketContext } from './phase17-cross-market';
import type { TradingMemoryContext } from './phase21-memory';

export const ADAPTIVE_REASONING_VERSION = 'reasoning-v1';

type RecordLike = Record<string, unknown>;

export type AdaptiveReasoningPolicy = {
  version: typeof ADAPTIVE_REASONING_VERSION;
  recommendedMode: 'FAST' | 'VERIFY' | 'DEEP';
  reasons: string[];
  criticChecks: string[];
  externalExpansionRecommended: boolean;
  policy: string;
};

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function at(root: unknown, ...path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return null;
    current = record[key];
  }
  return current ?? null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function analogOutcomeDisagreement(memory: TradingMemoryContext): boolean {
  const returns = memory.analogs
    .map((analog) => analog.outcome['15m'].returnBps)
    .filter((value): value is number => value !== null);
  if (returns.length < 4) return false;
  const positive = returns.filter((value) => value > 0).length;
  const negative = returns.filter((value) => value < 0).length;
  return positive / returns.length >= 0.3 && negative / returns.length >= 0.3;
}

export function buildAdaptiveReasoningPolicy(input: {
  snapshot: unknown;
  memory: TradingMemoryContext;
  crossMarket: CrossMarketContext;
  selectedExternalItemCount: number;
}): AdaptiveReasoningPolicy {
  const { snapshot, memory, crossMarket, selectedExternalItemCount } = input;
  const reasons: string[] = [];
  const criticChecks: string[] = ['COUNTER_THESIS'];

  const qualityValue = at(snapshot, 'decisionGates', 'quality');
  const quality = typeof qualityValue === 'string' ? qualityValue : 'RED';
  const criticalBlockers = strings(
    at(snapshot, 'decisionGates', 'criticalBlockers'),
  );
  const degradedSources = strings(
    at(snapshot, 'decisionGates', 'degradedSources'),
  );
  const highRiskNews = bool(at(snapshot, 'riskContext', 'highRiskNews'));
  const criticalNotice = bool(
    at(snapshot, 'riskContext', 'binanceCriticalNotice'),
  );
  const macroRemainingMs = number(
    at(snapshot, 'riskContext', 'nextMacroEvent', 'remainingMs'),
  );
  const macroSoon =
    macroRemainingMs !== null &&
    macroRemainingMs >= 0 &&
    macroRemainingMs <= 30 * 60_000;

  if (criticalBlockers.length > 0 || quality === 'RED') {
    reasons.push('DATA_BLOCKED_OR_RED');
    criticChecks.push('BLOCKER_RESOLUTION_ONLY');
    return {
      version: ADAPTIVE_REASONING_VERSION,
      recommendedMode: 'FAST',
      reasons,
      criticChecks,
      externalExpansionRecommended: false,
      policy:
        'Reasoning depth routing only. It does not determine LONG/SHORT or bypass decision gates.',
    };
  }

  if (highRiskNews) {
    reasons.push('HIGH_RISK_NEWS');
    criticChecks.push('EVENT_RISK');
  }
  if (criticalNotice) {
    reasons.push('BINANCE_CRITICAL_NOTICE');
    criticChecks.push('VENUE_EVENT_RISK');
  }
  if (macroSoon) {
    reasons.push('MACRO_EVENT_WITHIN_30M');
    criticChecks.push('MACRO_EVENT_WINDOW');
  }

  if (quality === 'YELLOW') {
    reasons.push('DATA_QUALITY_YELLOW');
    criticChecks.push('SOURCE_GAPS');
  }
  if (degradedSources.length > 0) {
    reasons.push('DEGRADED_SOURCES');
    criticChecks.push('EXCLUDE_DEGRADED_EVIDENCE');
  }
  if (crossMarket.completeness < 0.67) {
    reasons.push('CROSS_MARKET_PARTIAL');
    criticChecks.push('CROSS_MARKET_GAP');
  }
  if (memory.status === 'READY' && analogOutcomeDisagreement(memory)) {
    reasons.push('HISTORICAL_ANALOG_DISAGREEMENT');
    criticChecks.push('ANALOG_COUNTEREXAMPLE');
  }
  if (memory.status === 'SPARSE' || memory.status === 'NO_MATCH') {
    reasons.push('HISTORICAL_MEMORY_WEAK');
  }

  const deepReason = highRiskNews || criticalNotice || macroSoon;
  const verifyReason =
    quality === 'YELLOW' ||
    degradedSources.length > 0 ||
    crossMarket.completeness < 0.67 ||
    analogOutcomeDisagreement(memory);
  const recommendedMode = deepReason
    ? 'DEEP'
    : verifyReason
      ? 'VERIFY'
      : 'FAST';

  return {
    version: ADAPTIVE_REASONING_VERSION,
    recommendedMode,
    reasons,
    criticChecks: [...new Set(criticChecks)].slice(0, 8),
    externalExpansionRecommended:
      recommendedMode === 'DEEP' && selectedExternalItemCount < 4,
    policy:
      'Reasoning depth routing only. GPT must perform the market interpretation and final trade judgment.',
  };
}
