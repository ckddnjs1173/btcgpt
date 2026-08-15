import type { Env } from './index';

export const MARKET_FINGERPRINT_VERSION = 'mf-v1';
const FINGERPRINT_CACHE_TTL_MS = 30 * 60_000;

type RecordLike = Record<string, unknown>;

type CachedFingerprintRow = {
  snapshotId: string;
  marketGeneratedAt: number;
  fingerprintVersion: string;
  featureCount: number;
  presentFeatureCount: number;
  completeness: number;
  payload: string;
};

export type MarketFingerprint = {
  version: typeof MARKET_FINGERPRINT_VERSION;
  snapshotId: string;
  marketGeneratedAt: number;
  anchorMarkPrice: number | null;
  features: Record<string, number | null>;
  missingFeatures: string[];
  featureCount: number;
  presentFeatureCount: number;
  completeness: number;
};

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBooleanNumber(value: unknown): number | null {
  return value === true ? 1 : value === false ? 0 : null;
}

function at(root: RecordLike | null, ...path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function numberAt(root: RecordLike | null, ...path: string[]): number | null {
  return asNumber(at(root, ...path));
}

function booleanAt(root: RecordLike | null, ...path: string[]): number | null {
  return asBooleanNumber(at(root, ...path));
}

function bpsDistance(value: number | null, reference: number | null): number | null {
  return value !== null && reference !== null && reference !== 0
    ? ((value - reference) / reference) * 10_000
    : null;
}

function signedRatioFromUnitInterval(value: number | null): number | null {
  return value === null ? null : value * 2 - 1;
}

function centeredRatio(value: number | null): number | null {
  return value === null ? null : value - 1;
}

function liquidationSkew(
  longNotional: number | null,
  shortNotional: number | null,
): number | null {
  if (longNotional === null || shortNotional === null) return null;
  const total = longNotional + shortNotional;
  return total > 0 ? (shortNotional - longNotional) / total : 0;
}

function liquidationIntensityBps(
  longNotional: number | null,
  shortNotional: number | null,
  openInterestNotional: number | null,
): number | null {
  if (
    longNotional === null ||
    shortNotional === null ||
    openInterestNotional === null ||
    openInterestNotional <= 0
  )
    return null;
  return ((longNotional + shortNotional) / openInterestNotional) * 10_000;
}

function wallSkew(
  bidWallNotional: number | null,
  askWallNotional: number | null,
): number | null {
  if (bidWallNotional === null || askWallNotional === null) return null;
  const total = bidWallNotional + askWallNotional;
  return total > 0 ? (bidWallNotional - askWallNotional) / total : 0;
}

function addTimeframeFeatures(
  features: Record<string, number | null>,
  root: RecordLike,
  timeframe: '1m' | '5m' | '15m' | '1h' | '4h',
  markPrice: number | null,
): void {
  const prefix = `tf.${timeframe}`;
  const indicatorPath = ['timeframes', timeframe, 'indicators'];
  features[`${prefix}.return1Pct`] = numberAt(root, ...indicatorPath, 'return1');
  features[`${prefix}.return3Pct`] = numberAt(root, ...indicatorPath, 'return3');
  features[`${prefix}.return12Pct`] = numberAt(root, ...indicatorPath, 'return12');
  features[`${prefix}.atrPercent`] = numberAt(root, ...indicatorPath, 'atrPercent');
  features[`${prefix}.realizedVolatilityPct`] = numberAt(
    root,
    ...indicatorPath,
    'realizedVolatility',
  );
  features[`${prefix}.rsi14`] = numberAt(root, ...indicatorPath, 'rsi14');
  features[`${prefix}.ema20DistanceBps`] = bpsDistance(
    markPrice,
    numberAt(root, ...indicatorPath, 'ema20'),
  );
  features[`${prefix}.ema50DistanceBps`] = bpsDistance(
    markPrice,
    numberAt(root, ...indicatorPath, 'ema50'),
  );
  features[`${prefix}.ema200DistanceBps`] = bpsDistance(
    markPrice,
    numberAt(root, ...indicatorPath, 'ema200'),
  );
}

function addScalpFeatures(
  features: Record<string, number | null>,
  root: RecordLike,
  timeframe: '1m' | '5m',
  markPrice: number | null,
): void {
  const prefix = `scalp.${timeframe}`;
  const path = ['scalpContext', 'candles', timeframe];
  features[`${prefix}.bodyRatio`] = numberAt(root, ...path, 'bodyRatio');
  features[`${prefix}.upperWickRatio`] = numberAt(root, ...path, 'upperWickRatio');
  features[`${prefix}.lowerWickRatio`] = numberAt(root, ...path, 'lowerWickRatio');
  features[`${prefix}.closeLocation`] = numberAt(root, ...path, 'closeLocation');
  const emaSlope = numberAt(root, ...path, 'ema20SlopePerCandle');
  features[`${prefix}.ema20SlopeBpsPerCandle`] =
    emaSlope !== null && markPrice !== null && markPrice !== 0
      ? (emaSlope / markPrice) * 10_000
      : null;
  features[`${prefix}.vwapDistanceBps`] = numberAt(
    root,
    ...path,
    'vwapDistanceBps',
  );
  features[`${prefix}.pivotHighDistanceAtr`] = numberAt(
    root,
    ...path,
    'pivotHighDistanceAtr',
  );
  features[`${prefix}.pivotLowDistanceAtr`] = numberAt(
    root,
    ...path,
    'pivotLowDistanceAtr',
  );
  features[`${prefix}.rangeCompression5vs20`] = numberAt(
    root,
    ...path,
    'rangeCompression5vs20',
  );
  features[`${prefix}.volumeZScore`] = numberAt(root, ...path, 'volumeZScore');
}

function addOrderFlowFeatures(
  features: Record<string, number | null>,
  root: RecordLike,
  window: '15s' | '1m' | '5m',
): void {
  const prefix = `flow.${window}`;
  const path = ['orderFlow', window];
  features[`${prefix}.buyPressure`] = signedRatioFromUnitInterval(
    numberAt(root, ...path, 'buyRatio'),
  );
  features[`${prefix}.priceChangeBps`] = numberAt(
    root,
    ...path,
    'priceChangeBps',
  );
  features[`${prefix}.tradesPerSecond`] = numberAt(
    root,
    ...path,
    'tradesPerSecond',
  );
  features[`${prefix}.impactBpsPerBtc`] = numberAt(
    root,
    ...path,
    'impactBpsPerBtc',
  );
}

export function buildMarketFingerprint(snapshot: unknown): MarketFingerprint | null {
  const root = asRecord(snapshot);
  if (!root) return null;
  const snapshotId = typeof root.snapshotId === 'string' ? root.snapshotId : null;
  const marketGeneratedAt = asNumber(root.generatedAt);
  if (!snapshotId || marketGeneratedAt === null) return null;

  const markPrice = numberAt(root, 'marketState', 'markPrice');
  const indexPrice = numberAt(root, 'marketState', 'indexPrice');
  const microPrice = numberAt(root, 'orderFlow', 'microPrice');
  const openInterestNotional = numberAt(root, 'openInterest', 'notional');
  const features: Record<string, number | null> = {};

  features['market.spreadBps'] = numberAt(root, 'marketState', 'spreadBps');
  features['market.basisPercent'] = numberAt(root, 'marketState', 'basisPercent');
  const fundingRate = numberAt(root, 'marketState', 'fundingRate');
  features['market.fundingRateBps'] =
    fundingRate === null ? null : fundingRate * 10_000;
  features['market.priceChangePercent24h'] = numberAt(
    root,
    'marketState',
    'priceChangePercent24h',
  );
  features['market.markToIndexBps'] = bpsDistance(markPrice, indexPrice);
  features['market.microPriceDistanceBps'] = bpsDistance(microPrice, markPrice);

  for (const timeframe of ['1m', '5m', '15m', '1h', '4h'] as const)
    addTimeframeFeatures(features, root, timeframe, markPrice);

  for (const timeframe of ['1m', '5m'] as const)
    addScalpFeatures(features, root, timeframe, markPrice);

  for (const window of ['15s', '1m', '5m'] as const)
    addOrderFlowFeatures(features, root, window);

  features['depth.imbalance20'] = numberAt(root, 'orderFlow', 'orderBookImbalance20');
  features['depth.imbalance50'] = numberAt(root, 'orderFlow', 'orderBookImbalance50');
  features['depth.imbalance100'] = numberAt(root, 'orderFlow', 'orderBookImbalance100');
  features['depth.imbalanceChange5s'] = numberAt(
    root,
    'scalpContext',
    'depth',
    'imbalanceChange5s',
  );
  features['depth.imbalanceChange30s'] = numberAt(
    root,
    'scalpContext',
    'depth',
    'imbalanceChange30s',
  );
  features['depth.bidDominanceRatio5s'] = numberAt(
    root,
    'scalpContext',
    'depth',
    'bidDominanceRatio5s',
  );
  features['depth.wallSkew'] = wallSkew(
    numberAt(root, 'scalpContext', 'depth', 'bidWallNotional'),
    numberAt(root, 'scalpContext', 'depth', 'askWallNotional'),
  );

  features['oi.localChange1mPct'] = numberAt(
    root,
    'openInterest',
    'localChanges',
    '1m',
  );
  features['oi.localChange5mPct'] = numberAt(
    root,
    'openInterest',
    'localChanges',
    '5m',
  );
  for (const window of ['5m', '15m', '1h', '4h'] as const)
    features[`oi.change${window}Pct`] = numberAt(
      root,
      'openInterest',
      'changes',
      window,
    );

  features['sentiment.globalAccountCentered'] = centeredRatio(
    numberAt(root, 'sentiment', 'globalLongShortAccountRatio'),
  );
  features['sentiment.topAccountCentered'] = centeredRatio(
    numberAt(root, 'sentiment', 'topLongShortAccountRatio'),
  );
  features['sentiment.topPositionCentered'] = centeredRatio(
    numberAt(root, 'sentiment', 'topLongShortPositionRatio'),
  );
  features['sentiment.takerCentered'] = centeredRatio(
    numberAt(root, 'sentiment', 'takerBuySellRatio'),
  );

  for (const window of ['1m', '5m', '15m'] as const) {
    const longNotional = numberAt(root, 'liquidations', window, 'longNotional');
    const shortNotional = numberAt(root, 'liquidations', window, 'shortNotional');
    features[`liquidation.${window}.skew`] = liquidationSkew(
      longNotional,
      shortNotional,
    );
    features[`liquidation.${window}.intensityBpsOfOi`] =
      liquidationIntensityBps(
        longNotional,
        shortNotional,
        openInterestNotional,
      );
  }

  features['risk.highRiskNews'] = booleanAt(root, 'riskContext', 'highRiskNews');
  features['risk.binanceCriticalNotice'] = booleanAt(
    root,
    'riskContext',
    'binanceCriticalNotice',
  );
  features['risk.onchainAnomaly'] = booleanAt(root, 'riskContext', 'onchainAnomaly');
  const macroRemainingMs = numberAt(
    root,
    'riskContext',
    'nextMacroEvent',
    'remainingMs',
  );
  features['risk.nextMacroEventMinutes'] =
    macroRemainingMs === null ? null : macroRemainingMs / 60_000;
  features['risk.fearAndGreed'] = numberAt(
    root,
    'riskContext',
    'fearAndGreed',
    'value',
  );

  const generatedDate = new Date(marketGeneratedAt);
  const hourRadians = (generatedDate.getUTCHours() / 24) * Math.PI * 2;
  const weekdayRadians = (generatedDate.getUTCDay() / 7) * Math.PI * 2;
  features['session.utcHourSin'] = Math.sin(hourRadians);
  features['session.utcHourCos'] = Math.cos(hourRadians);
  features['session.utcWeekdaySin'] = Math.sin(weekdayRadians);
  features['session.utcWeekdayCos'] = Math.cos(weekdayRadians);

  const missingFeatures = Object.entries(features)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  const featureCount = Object.keys(features).length;
  const presentFeatureCount = featureCount - missingFeatures.length;

  return {
    version: MARKET_FINGERPRINT_VERSION,
    snapshotId,
    marketGeneratedAt,
    anchorMarkPrice: markPrice,
    features,
    missingFeatures,
    featureCount,
    presentFeatureCount,
    completeness: featureCount === 0 ? 0 : presentFeatureCount / featureCount,
  };
}

async function saveCachedFingerprint(
  env: Env,
  fingerprint: MarketFingerprint,
  cachedAt: number,
): Promise<void> {
  if (!env.DB) return;
  const result = await env.DB.prepare(
    `INSERT INTO snapshot_fingerprint_cache (
      snapshot_id, market_generated_at, fingerprint_version, feature_count,
      present_feature_count, completeness, payload, cached_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_id) DO UPDATE SET
      market_generated_at=excluded.market_generated_at,
      fingerprint_version=excluded.fingerprint_version,
      feature_count=excluded.feature_count,
      present_feature_count=excluded.present_feature_count,
      completeness=excluded.completeness,
      payload=excluded.payload,
      cached_at=excluded.cached_at`,
  )
    .bind(
      fingerprint.snapshotId,
      fingerprint.marketGeneratedAt,
      fingerprint.version,
      fingerprint.featureCount,
      fingerprint.presentFeatureCount,
      fingerprint.completeness,
      JSON.stringify(fingerprint),
      cachedAt,
    )
    .run();
  if (!result.success) throw new Error('D1_FINGERPRINT_CACHE_WRITE_FAILED');
}

async function cleanupFingerprintCache(env: Env, now: number): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare('DELETE FROM snapshot_fingerprint_cache WHERE cached_at < ?')
    .bind(now - FINGERPRINT_CACHE_TTL_MS)
    .run();
}

export async function cacheMarketFingerprintFromSnapshot(
  env: Env,
  snapshot: unknown,
  observedAt = Date.now(),
): Promise<MarketFingerprint | null> {
  const fingerprint = buildMarketFingerprint(snapshot);
  if (!fingerprint || !env.DB) return fingerprint;
  await saveCachedFingerprint(env, fingerprint, observedAt);
  await cleanupFingerprintCache(env, observedAt);
  return fingerprint;
}

async function loadCachedFingerprint(
  env: Env,
  snapshotId: string,
  marketGeneratedAt: number,
): Promise<MarketFingerprint | null> {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    `SELECT snapshot_id AS snapshotId,
      market_generated_at AS marketGeneratedAt,
      fingerprint_version AS fingerprintVersion,
      feature_count AS featureCount,
      present_feature_count AS presentFeatureCount,
      completeness,
      payload
     FROM snapshot_fingerprint_cache
     WHERE snapshot_id = ? AND market_generated_at = ?`,
  )
    .bind(snapshotId, marketGeneratedAt)
    .first<CachedFingerprintRow>();
  if (!row || row.fingerprintVersion !== MARKET_FINGERPRINT_VERSION) return null;
  try {
    const parsed = JSON.parse(row.payload) as MarketFingerprint;
    return parsed.snapshotId === snapshotId &&
      parsed.marketGeneratedAt === marketGeneratedAt &&
      parsed.version === MARKET_FINGERPRINT_VERSION
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function attachMarketFingerprintToDecision(
  env: Env,
  input: {
    decisionId: string;
    snapshotId: string;
    marketGeneratedAt: number;
    fallbackSnapshot?: unknown;
    linkedAt?: number;
  },
): Promise<boolean> {
  if (!env.DB) return false;
  let fingerprint = await loadCachedFingerprint(
    env,
    input.snapshotId,
    input.marketGeneratedAt,
  );
  if (!fingerprint && input.fallbackSnapshot !== undefined) {
    const fallback = buildMarketFingerprint(input.fallbackSnapshot);
    if (
      fallback?.snapshotId === input.snapshotId &&
      fallback.marketGeneratedAt === input.marketGeneratedAt
    )
      fingerprint = fallback;
  }
  if (!fingerprint) return false;

  const result = await env.DB.prepare(
    `INSERT INTO decision_market_fingerprint (
      decision_id, snapshot_id, market_generated_at, fingerprint_version,
      feature_count, present_feature_count, completeness, payload, linked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(decision_id) DO UPDATE SET
      snapshot_id=excluded.snapshot_id,
      market_generated_at=excluded.market_generated_at,
      fingerprint_version=excluded.fingerprint_version,
      feature_count=excluded.feature_count,
      present_feature_count=excluded.present_feature_count,
      completeness=excluded.completeness,
      payload=excluded.payload,
      linked_at=excluded.linked_at`,
  )
    .bind(
      input.decisionId,
      fingerprint.snapshotId,
      fingerprint.marketGeneratedAt,
      fingerprint.version,
      fingerprint.featureCount,
      fingerprint.presentFeatureCount,
      fingerprint.completeness,
      JSON.stringify(fingerprint),
      input.linkedAt ?? Date.now(),
    )
    .run();
  if (!result.success) throw new Error('D1_DECISION_FINGERPRINT_WRITE_FAILED');
  return true;
}
