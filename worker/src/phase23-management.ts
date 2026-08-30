import type { Env } from './index';

export const POSITION_MANAGEMENT_VERSION = 'management-v1';

type RecordLike = Record<string, unknown>;

type QualityRow = {
  decisionId: string;
  mfeBps: number | null;
  maeBps: number | null;
  mfeR: number | null;
  maeR: number | null;
  realizedNetR: number | null;
  entryDriftBps: number | null;
  decisionToPlanLockMs: number | null;
  triggerToTradeOpenMs: number | null;
  qualityUpdatedAt: number | null;
};

type ObservedProtectiveOrder = {
  side: string | null;
  type: string | null;
  price: number | null;
  triggerPrice: number | null;
  effectiveQuantity: number | null;
  reduceOnly: boolean | null;
  closePosition: boolean | null;
  updatedAt: number | null;
};

export type PositionManagementContext = {
  version: typeof POSITION_MANAGEMENT_VERSION;
  status: 'FLAT' | 'ACTIVE' | 'BLOCKED';
  lifecycleStage: string | null;
  mode: string | null;
  side: string | null;
  entryPrice: number | null;
  markPrice: number | null;
  remainingQuantity: number | null;
  leverage: number | null;
  liquidationPrice: number | null;
  stopPrice: number | null;
  targets: number[];
  holdingMinutes: number | null;
  priceR: {
    initialRiskPerUnit: number | null;
    unrealizedR: number | null;
    distanceToStopR: number | null;
    targetDistanceR: Array<{ target: number; distanceR: number | null }>;
  };
  protectiveCoverage: {
    stopLossCoverageRatio: number | null;
    takeProfitCoverageRatio: number | null;
    hasFullStopCoverage: boolean | null;
    hasFullTakeProfitCoverage: boolean | null;
    planMatchesPosition: boolean | null;
  };
  actualProtection: {
    source: 'BINANCE_READ_ONLY' | 'NOT_APPLICABLE';
    observedAt: number | null;
    stopLosses: ObservedProtectiveOrder[];
    takeProfits: ObservedProtectiveOrder[];
    trailingStops: ObservedProtectiveOrder[];
    otherProtectiveOrders: ObservedProtectiveOrder[];
  };
  tradeQuality: QualityRow | null;
  flags: string[];
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

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = number(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is number =>
          typeof item === 'number' && Number.isFinite(item),
      )
    : [];
}

function sideSign(side: string | null): number | null {
  return side === 'LONG' ? 1 : side === 'SHORT' ? -1 : null;
}

function isProfitTakingLimit(input: {
  positionSide: string | null;
  orderSide: string | null;
  price: number | null;
  entryPrice: number | null;
}): boolean {
  const { positionSide, orderSide, price, entryPrice } = input;
  if (price === null || entryPrice === null) return false;
  return (
    (positionSide === 'LONG' && orderSide === 'SELL' && price > entryPrice) ||
    (positionSide === 'SHORT' && orderSide === 'BUY' && price < entryPrice)
  );
}

function observedProtection(input: {
  snapshot: unknown;
  mode: string | null;
  positionSide: string | null;
  entryPrice: number | null;
  remainingQuantity: number | null;
}): PositionManagementContext['actualProtection'] {
  const { snapshot, mode, positionSide, entryPrice, remainingQuantity } = input;
  const rawOrders = at(snapshot, 'trading', 'liveManual', 'protectiveOrders');
  const orders = Array.isArray(rawOrders)
    ? rawOrders
        .map(asRecord)
        .filter((order): order is RecordLike => order !== null)
    : [];
  const stopLosses: ObservedProtectiveOrder[] = [];
  const takeProfits: ObservedProtectiveOrder[] = [];
  const trailingStops: ObservedProtectiveOrder[] = [];
  const otherProtectiveOrders: ObservedProtectiveOrder[] = [];

  for (const order of orders) {
    const orderType = text(order.type);
    const orderSide = text(order.side);
    const closePosition = boolean(order.closePosition);
    const quantity = positiveNumber(order.quantity);
    const normalized: ObservedProtectiveOrder = {
      side: orderSide,
      type: orderType,
      price: positiveNumber(order.price),
      triggerPrice: positiveNumber(order.stopPrice),
      effectiveQuantity:
        closePosition === true &&
        remainingQuantity !== null &&
        remainingQuantity > 0
          ? remainingQuantity
          : quantity,
      reduceOnly: boolean(order.reduceOnly),
      closePosition,
      updatedAt: number(order.updatedAt),
    };

    if (orderType === 'STOP' || orderType === 'STOP_MARKET') {
      stopLosses.push(normalized);
      continue;
    }
    if (orderType === 'TAKE_PROFIT' || orderType === 'TAKE_PROFIT_MARKET') {
      takeProfits.push(normalized);
      continue;
    }
    if (orderType === 'TRAILING_STOP_MARKET') {
      trailingStops.push(normalized);
      continue;
    }
    if (
      orderType === 'LIMIT' &&
      isProfitTakingLimit({
        positionSide,
        orderSide,
        price: normalized.price,
        entryPrice,
      })
    ) {
      takeProfits.push(normalized);
      continue;
    }
    otherProtectiveOrders.push(normalized);
  }

  const observedAtValues = orders
    .map((order) => number(order.updatedAt))
    .filter((value): value is number => value !== null);

  return {
    source: mode === 'LIVE_MANUAL' ? 'BINANCE_READ_ONLY' : 'NOT_APPLICABLE',
    observedAt:
      observedAtValues.length > 0 ? Math.max(...observedAtValues) : null,
    stopLosses,
    takeProfits,
    trailingStops,
    otherProtectiveOrders,
  };
}

function riskMetrics(input: {
  side: string | null;
  entryPrice: number | null;
  markPrice: number | null;
  stopPrice: number | null;
  targets: number[];
}) {
  const { side, entryPrice, markPrice, stopPrice, targets } = input;
  const sign = sideSign(side);
  const initialRiskPerUnit =
    entryPrice !== null && stopPrice !== null
      ? Math.abs(entryPrice - stopPrice)
      : null;
  const validRisk = initialRiskPerUnit !== null && initialRiskPerUnit > 0;
  const unrealizedR =
    sign !== null && entryPrice !== null && markPrice !== null && validRisk
      ? (sign * (markPrice - entryPrice)) / initialRiskPerUnit
      : null;
  const distanceToStopR =
    sign !== null && markPrice !== null && stopPrice !== null && validRisk
      ? (sign * (markPrice - stopPrice)) / initialRiskPerUnit
      : null;
  const targetDistanceR = targets.map((target) => ({
    target,
    distanceR:
      sign !== null && markPrice !== null && validRisk
        ? (sign * (target - markPrice)) / initialRiskPerUnit
        : null,
  }));
  return {
    initialRiskPerUnit,
    unrealizedR,
    distanceToStopR,
    targetDistanceR,
  };
}

async function loadTradeQuality(
  env: Env,
  planId: string | null,
): Promise<QualityRow | null> {
  if (!env.DB || !planId) return null;
  try {
    return await env.DB.prepare(
      `SELECT
          decision_id AS decisionId,
          mfe_bps AS mfeBps,
          mae_bps AS maeBps,
          mfe_r AS mfeR,
          mae_r AS maeR,
          realized_net_r AS realizedNetR,
          entry_drift_bps AS entryDriftBps,
          decision_to_plan_lock_ms AS decisionToPlanLockMs,
          trigger_to_trade_open_ms AS triggerToTradeOpenMs,
          quality_updated_at AS qualityUpdatedAt
         FROM decision_trade_lineage
         WHERE plan_id = ?
         LIMIT 1`,
    )
      .bind(planId)
      .first<QualityRow>();
  } catch {
    return null;
  }
}

export async function buildPositionManagementContext(
  env: Env,
  snapshot: unknown,
  now = Date.now(),
): Promise<PositionManagementContext> {
  const lifecycleStage = text(at(snapshot, 'trading', 'lifecycle', 'stage'));
  const mode = text(at(snapshot, 'trading', 'mode'));
  const managementAvailable = at(
    snapshot,
    'decisionGates',
    'positionManagementAvailable',
  );
  const activePlan = asRecord(at(snapshot, 'trading', 'activePlan'));
  const activePaperTrade = asRecord(
    at(snapshot, 'trading', 'activePaperTrade'),
  );
  const activeLiveTrade = asRecord(at(snapshot, 'trading', 'activeLiveTrade'));
  const livePosition = asRecord(
    at(snapshot, 'trading', 'liveManual', 'position'),
  );
  const snapshotPosition = asRecord(at(snapshot, 'position'));
  const position = livePosition ?? snapshotPosition;
  const activeTrade = activePaperTrade ?? activeLiveTrade;

  const positionSide = text(position?.side);
  const tradeSide = text(activeTrade?.side);
  const planSide = text(activePlan?.side);
  const side =
    positionSide && positionSide !== 'FLAT'
      ? positionSide
      : (tradeSide ?? planSide);
  const entryPrice =
    number(activeTrade?.entryPrice) ??
    number(position?.entryPrice) ??
    number(activePlan?.entry);
  const markPrice =
    number(position?.markPrice) ??
    number(activeTrade?.lastMarkPrice) ??
    number(at(snapshot, 'marketState', 'markPrice'));
  const remainingQuantity =
    number(activeTrade?.remainingQuantity) ??
    number(position?.quantity) ??
    null;
  const leverage =
    number(position?.leverage) ??
    number(activeTrade?.leverage) ??
    number(activePlan?.leverage);
  const liquidationPrice = number(position?.liquidationPrice);
  const stopPrice = number(activePlan?.stop) ?? number(position?.stopPrice);
  const targets =
    numberArray(activePlan?.targets).length > 0
      ? numberArray(activePlan?.targets)
      : numberArray(position?.targetPrices);
  const openedAt =
    number(activeTrade?.openedAt) ?? number(position?.openedAt) ?? null;
  const holdingMinutes =
    openedAt !== null ? Math.max(0, now - openedAt) / 60_000 : null;
  const planId = text(activePlan?.id) ?? text(activeTrade?.planId);
  const tradeQuality = await loadTradeQuality(env, planId);
  const risk = riskMetrics({
    side,
    entryPrice,
    markPrice,
    stopPrice,
    targets,
  });
  const actualProtection = observedProtection({
    snapshot,
    mode,
    positionSide: side,
    entryPrice,
    remainingQuantity,
  });

  const stopLossCoverageRatio = number(
    at(
      snapshot,
      'trading',
      'liveManual',
      'protectiveCoverage',
      'stopLossCoverageRatio',
    ),
  );
  const takeProfitCoverageRatio = number(
    at(
      snapshot,
      'trading',
      'liveManual',
      'protectiveCoverage',
      'takeProfitCoverageRatio',
    ),
  );
  const hasFullStopCoverage = boolean(
    at(
      snapshot,
      'trading',
      'liveManual',
      'protectiveCoverage',
      'hasFullStopCoverage',
    ),
  );
  const hasFullTakeProfitCoverage = boolean(
    at(
      snapshot,
      'trading',
      'liveManual',
      'protectiveCoverage',
      'hasFullTakeProfitCoverage',
    ),
  );
  const planMatchesPosition = boolean(
    at(snapshot, 'trading', 'liveManual', 'planMatchesPosition'),
  );

  const active =
    lifecycleStage === 'MANAGING' ||
    (remainingQuantity !== null &&
      remainingQuantity > 0 &&
      sideSign(side) !== null);
  const flags: string[] = [];
  if (active && managementAvailable === false)
    flags.push('MANAGEMENT_DATA_BLOCKED');
  if (active && hasFullStopCoverage === false) flags.push('STOP_COVERAGE_GAP');
  if (active && planMatchesPosition === false)
    flags.push('PLAN_POSITION_MISMATCH');
  if (active && risk.distanceToStopR !== null && risk.distanceToStopR <= 0.25) {
    flags.push('STOP_DISTANCE_LE_0_25R');
  }

  return {
    version: POSITION_MANAGEMENT_VERSION,
    status: !active
      ? 'FLAT'
      : managementAvailable === false
        ? 'BLOCKED'
        : 'ACTIVE',
    lifecycleStage,
    mode,
    side,
    entryPrice,
    markPrice,
    remainingQuantity,
    leverage,
    liquidationPrice,
    stopPrice,
    targets,
    holdingMinutes,
    priceR: risk,
    protectiveCoverage: {
      stopLossCoverageRatio,
      takeProfitCoverageRatio,
      hasFullStopCoverage,
      hasFullTakeProfitCoverage,
      planMatchesPosition,
    },
    actualProtection,
    tradeQuality,
    flags,
    policy:
      'Deterministic management telemetry only. GPT decides HOLD/PARTIAL_EXIT/EXIT/MOVE_STOP/CHANGE_TP.',
  };
}
