import type { Env } from './index';
import type { CrossMarketContext } from './phase17-cross-market';
import {
  buildTradingMemory,
  type TradingMemoryContext,
} from './phase21-memory';
import {
  buildAdaptiveReasoningPolicy,
  type AdaptiveReasoningPolicy,
} from './phase22-reasoning';
import {
  buildPositionManagementContext,
  type PositionManagementContext,
} from './phase23-management';

export const CONTEXT_PACK_VERSION = 'context-v2';
const MAX_EXTERNAL_ITEMS = 12;

type RecordLike = Record<string, unknown>;

type ExternalContextRow = {
  raw: string;
  generatedAt: number;
  receivedAt: number;
};

type ReplayRow = {
  snapshotPayload: string;
};

type ContextPack = {
  version: typeof CONTEXT_PACK_VERSION;
  generatedAt: number;
  snapshotId: string | null;
  marketGeneratedAt: number | null;
  objectiveOnly: true;
  btcCore: Record<string, unknown>;
  crossMarket: CrossMarketContext;
  external: {
    status: string;
    ageMs: number | null;
    riskContext: unknown;
    selectedItems: Array<Record<string, unknown>>;
    totalCandidateItems: number;
  };
  tradingMemory: TradingMemoryContext;
  reasoningPolicy: AdaptiveReasoningPolicy;
  positionManagement: PositionManagementContext;
  routing: {
    maxExternalItems: number;
    selectionPolicy: string;
    omitted: string[];
    sourceSet: string[];
  };
  completeness: {
    crossMarket: number;
    externalAvailable: boolean;
    btcDecisionGateQuality: string | null;
    memoryStatus: TradingMemoryContext['status'];
    managementStatus: PositionManagementContext['status'];
  };
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

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compactOrderFlow(snapshot: unknown, window: '1m' | '5m' | '15m') {
  const source = asRecord(at(snapshot, 'orderFlow', window));
  if (!source) return null;
  return {
    sampleCount: number(source.sampleCount),
    buyRatio: number(source.buyRatio),
    delta: number(source.delta),
    cumulativeDelta: number(source.cumulativeDelta),
    tradesPerSecond: number(source.tradesPerSecond),
    notionalPerSecond: number(source.notionalPerSecond),
    priceChangeBps: number(source.priceChangeBps),
    impactBpsPerBtc: number(source.impactBpsPerBtc),
    deltaPriceRelation: text(source.deltaPriceRelation),
  };
}

function compactTimeframe(snapshot: unknown, timeframe: string) {
  const indicators = asRecord(
    at(snapshot, 'timeframes', timeframe, 'indicators'),
  );
  if (!indicators) return null;
  return {
    status: text(at(snapshot, 'timeframes', timeframe, 'status')),
    ema20: number(indicators.ema20),
    ema50: number(indicators.ema50),
    ema200: number(indicators.ema200),
    rsi14: number(indicators.rsi14),
    atrPercent: number(indicators.atrPercent),
    volumeRatio: number(indicators.volumeRatio),
    vwap: number(indicators.vwap),
    high20: number(indicators.high20),
    low20: number(indicators.low20),
    pivotHigh: number(indicators.pivotHigh),
    pivotLow: number(indicators.pivotLow),
    return1: number(indicators.return1),
    return3: number(indicators.return3),
    return12: number(indicators.return12),
    realizedVolatility: number(indicators.realizedVolatility),
  };
}

function btcCore(snapshot: unknown): Record<string, unknown> {
  return {
    decisionGates: {
      marketAnalysisAvailable: at(
        snapshot,
        'decisionGates',
        'marketAnalysisAvailable',
      ),
      entryAllowed: at(snapshot, 'decisionGates', 'entryAllowed'),
      positionManagementAvailable: at(
        snapshot,
        'decisionGates',
        'positionManagementAvailable',
      ),
      quality: at(snapshot, 'decisionGates', 'quality'),
      criticalBlockers: at(snapshot, 'decisionGates', 'criticalBlockers'),
      degradedSources: at(snapshot, 'decisionGates', 'degradedSources'),
    },
    marketState: {
      lastPrice: at(snapshot, 'marketState', 'lastPrice'),
      markPrice: at(snapshot, 'marketState', 'markPrice'),
      indexPrice: at(snapshot, 'marketState', 'indexPrice'),
      spreadBps: at(snapshot, 'marketState', 'spreadBps'),
      fundingRate: at(snapshot, 'marketState', 'fundingRate'),
      nextFundingTime: at(snapshot, 'marketState', 'nextFundingTime'),
      basisPercent: at(snapshot, 'marketState', 'basisPercent'),
      priceChangePercent24h: at(
        snapshot,
        'marketState',
        'priceChangePercent24h',
      ),
      quoteVolume24h: at(snapshot, 'marketState', 'quoteVolume24h'),
    },
    orderFlow: {
      '1m': compactOrderFlow(snapshot, '1m'),
      '5m': compactOrderFlow(snapshot, '5m'),
      '15m': compactOrderFlow(snapshot, '15m'),
      orderBookImbalance20: at(snapshot, 'orderFlow', 'orderBookImbalance20'),
      orderBookImbalance50: at(snapshot, 'orderFlow', 'orderBookImbalance50'),
      bidNotional20: at(snapshot, 'orderFlow', 'bidNotional20'),
      askNotional20: at(snapshot, 'orderFlow', 'askNotional20'),
      microPrice: at(snapshot, 'orderFlow', 'microPrice'),
      rollingCvd4h: at(snapshot, 'orderFlow', 'rollingCvd4h'),
      estimatedSlippage: at(snapshot, 'orderFlow', 'estimatedSlippage'),
    },
    openInterest: {
      current: at(snapshot, 'openInterest', 'current'),
      notional: at(snapshot, 'openInterest', 'notional'),
      changes: at(snapshot, 'openInterest', 'changes'),
      localChanges: at(snapshot, 'openInterest', 'localChanges'),
    },
    sentiment: at(snapshot, 'sentiment'),
    liquidations: {
      '5m': at(snapshot, 'liquidations', '5m'),
      '15m': at(snapshot, 'liquidations', '15m'),
      '1h': at(snapshot, 'liquidations', '1h'),
    },
    timeframes: Object.fromEntries(
      ['1m', '5m', '15m', '1h', '4h', '1d'].map((timeframe) => [
        timeframe,
        compactTimeframe(snapshot, timeframe),
      ]),
    ),
    scalpContext: {
      candles: at(snapshot, 'scalpContext', 'candles'),
      depth: at(snapshot, 'scalpContext', 'depth'),
    },
    position: at(snapshot, 'position'),
    costSettings: at(snapshot, 'costSettings'),
  };
}

function trustRank(value: unknown): number {
  return (
    {
      OFFICIAL: 0,
      MULTI_SOURCE: 1,
      SINGLE_SOURCE: 2,
      UNVERIFIED_SOCIAL: 3,
    }[String(value)] ?? 4
  );
}

function relevanceRank(value: unknown): number {
  return { HIGH: 0, MEDIUM: 1, LOW: 2 }[String(value)] ?? 3;
}

function selectedExternalItems(
  payload: unknown,
): Array<Record<string, unknown>> {
  const root = asRecord(payload);
  const rawItems = Array.isArray(root?.items) ? root.items : [];
  return rawItems
    .map(asRecord)
    .filter((item): item is RecordLike => item !== null)
    .sort((a, b) => {
      const relevanceDifference =
        relevanceRank(a.btcRelevance) - relevanceRank(b.btcRelevance);
      if (relevanceDifference !== 0) return relevanceDifference;
      const trustDifference = trustRank(a.trustTier) - trustRank(b.trustTier);
      if (trustDifference !== 0) return trustDifference;
      return number(b.publishedAt)! - number(a.publishedAt)!;
    })
    .slice(0, MAX_EXTERNAL_ITEMS)
    .map((item) => ({
      id: item.id,
      source: item.source,
      category: item.category,
      title: item.title,
      snippet: item.snippet,
      publishedAt: item.publishedAt,
      trustTier: item.trustTier,
      btcRelevance: item.btcRelevance,
      duplicateCount: item.duplicateCount,
      tags: item.tags,
    }));
}

async function loadExternalContext(env: Env): Promise<{
  payload: unknown;
  generatedAt: number;
  receivedAt: number;
} | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT payload AS raw, generated_at AS generatedAt,
        received_at AS receivedAt
       FROM external_context_payloads WHERE horizon = 'INTRADAY'`,
    ).first<ExternalContextRow>();
    if (!row) return null;
    return {
      payload: JSON.parse(row.raw) as unknown,
      generatedAt: row.generatedAt,
      receivedAt: row.receivedAt,
    };
  } catch {
    return null;
  }
}

export async function buildContextPack(
  env: Env,
  snapshot: unknown,
  crossMarket: CrossMarketContext,
  now = Date.now(),
): Promise<ContextPack> {
  const external = await loadExternalContext(env);
  const externalRoot = asRecord(external?.payload ?? null);
  const selectedItems = selectedExternalItems(external?.payload ?? null);
  const candidates = Array.isArray(externalRoot?.items)
    ? externalRoot.items.length
    : 0;
  const [tradingMemory, positionManagement] = await Promise.all([
    buildTradingMemory(env, snapshot, now),
    buildPositionManagementContext(env, snapshot, now),
  ]);
  const reasoningPolicy = buildAdaptiveReasoningPolicy({
    snapshot,
    memory: tradingMemory,
    crossMarket,
    selectedExternalItemCount: selectedItems.length,
  });

  const sourceSet = new Set<string>(['BINANCE_BTC_LOCAL']);
  if (crossMarket.completeness > 0) {
    sourceSet.add('BINANCE_USDM_CROSS_MARKET');
    sourceSet.add('COINBASE_SPOT');
  }
  if (tradingMemory.status === 'READY' || tradingMemory.status === 'SPARSE') {
    sourceSet.add('TRADING_MEMORY');
  }
  if (positionManagement.status !== 'FLAT') {
    sourceSet.add('TRADE_QUALITY_TELEMETRY');
  }
  for (const item of selectedItems) {
    if (typeof item.source === 'string') sourceSet.add(item.source);
  }

  return {
    version: CONTEXT_PACK_VERSION,
    generatedAt: now,
    snapshotId: text(at(snapshot, 'snapshotId')),
    marketGeneratedAt: number(at(snapshot, 'generatedAt')),
    objectiveOnly: true,
    btcCore: btcCore(snapshot),
    crossMarket,
    external: {
      status: text(externalRoot?.status) ?? 'UNAVAILABLE',
      ageMs: external ? Math.max(0, now - external.generatedAt) : null,
      riskContext: externalRoot?.riskContext ?? at(snapshot, 'riskContext'),
      selectedItems,
      totalCandidateItems: candidates,
    },
    tradingMemory,
    reasoningPolicy,
    positionManagement,
    routing: {
      maxExternalItems: MAX_EXTERNAL_ITEMS,
      selectionPolicy:
        'BTC relevance, trust tier, recency, historical similarity and task-specific management telemetry; no local directional score',
      omitted: [
        'full candle arrays',
        'full order book levels',
        'duplicate external articles',
        'local bullish/bearish labels',
        'local LONG/SHORT score',
        'future replay outcomes for the current case',
      ],
      sourceSet: [...sourceSet].sort(),
    },
    completeness: {
      crossMarket: crossMarket.completeness,
      externalAvailable: external !== null,
      btcDecisionGateQuality: text(at(snapshot, 'decisionGates', 'quality')),
      memoryStatus: tradingMemory.status,
      managementStatus: positionManagement.status,
    },
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (part) =>
    part.toString(16).padStart(2, '0'),
  ).join('');
}

export async function attachDecisionContextPack(
  env: Env,
  decisionId: string,
): Promise<boolean> {
  if (!env.DB) return false;
  try {
    const replay = await env.DB.prepare(
      `SELECT snapshot_payload AS snapshotPayload
       FROM replay_cases WHERE decision_id = ?`,
    )
      .bind(decisionId)
      .first<ReplayRow>();
    if (!replay) return false;
    const snapshot = asRecord(JSON.parse(replay.snapshotPayload) as unknown);
    const pack = asRecord(snapshot?.intelligenceContext);
    if (!snapshot || !pack) return false;
    const payload = JSON.stringify(pack);
    const result = await env.DB.prepare(
      `INSERT INTO decision_context_pack (
        decision_id, context_pack_version, snapshot_id,
        market_generated_at, generated_at, payload_sha256, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(decision_id) DO NOTHING`,
    )
      .bind(
        decisionId,
        text(pack.version) ?? CONTEXT_PACK_VERSION,
        text(snapshot.snapshotId) ?? '',
        number(snapshot.generatedAt) ?? 0,
        number(pack.generatedAt) ?? Date.now(),
        await sha256(payload),
        payload,
      )
      .run();
    return result.success;
  } catch {
    return false;
  }
}
