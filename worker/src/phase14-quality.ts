export type EntryTimingQuality = 'EXACT' | 'INFERRED' | 'UNAVAILABLE';
export type CostBasis = 'PAPER_MODELED' | 'LIVE_FEES_ONLY' | 'LIVE_INCOMPLETE';

export type TradeQualityPrevious = {
  actualEntry: number | null;
  mfeBps: number | null;
  maeBps: number | null;
  mfeUsdt: number | null;
  maeUsdt: number | null;
};

export type TradeQualityPlan = {
  mode: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  estimatedMaxLoss: number | null;
  triggeredAt: number | null;
};

export type TradeQualityTrade = {
  status: string;
  entryPrice: number | null;
  initialQuantity: number | null;
  openedAt: number | null;
  closedAt: number | null;
  lastMarkPrice: number | null;
  realizedNetPnl: number | null;
  feesPaid: number | null;
  slippagePaid: number | null;
  fundingPaid: number | null;
  attribution: string | null;
};

export type TradeQualityTelemetry = {
  triggerToTradeOpenMs: number | null;
  entryTimingQuality: EntryTimingQuality;
  plannedEntry: number;
  actualEntry: number;
  entryDriftBps: number;
  initialRiskUsdt: number;
  mfeBps: number;
  maeBps: number;
  mfeUsdt: number;
  maeUsdt: number;
  mfeR: number;
  maeR: number;
  realizedNetR: number | null;
  holdingTimeMs: number | null;
  costBasis: CostBasis;
  qualityUpdatedAt: number;
};

function entryTimingQuality(
  mode: string,
  attribution: string | null,
): EntryTimingQuality {
  if (mode === 'PAPER') return 'EXACT';
  if (attribution === 'OBSERVED_FROM_FLAT') return 'EXACT';
  if (attribution === 'INFERRED_FROM_RECENT_TRADES') return 'INFERRED';
  return 'UNAVAILABLE';
}

function costBasis(mode: string, feesPaid: number | null): CostBasis {
  if (mode === 'PAPER') return 'PAPER_MODELED';
  return feesPaid === null ? 'LIVE_INCOMPLETE' : 'LIVE_FEES_ONLY';
}

function positiveFinite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function maximum(previous: number | null, current: number): number {
  return Math.max(previous ?? 0, current);
}

export function calculateTradeQuality(input: {
  plan: TradeQualityPlan;
  trade: TradeQualityTrade;
  currentMarkPrice: number | null;
  previous: TradeQualityPrevious | null;
  observedAt: number;
}): TradeQualityTelemetry | null {
  const { plan, trade, currentMarkPrice, previous, observedAt } = input;
  const actualEntry = positiveFinite(previous?.actualEntry ?? trade.entryPrice);
  const quantity = positiveFinite(trade.initialQuantity);
  if (quantity === null || actualEntry === null) return null;

  const initialRiskUsdt =
    positiveFinite(plan.estimatedMaxLoss) ??
    positiveFinite(Math.abs(plan.entry - plan.stop) * quantity);
  if (initialRiskUsdt === null) return null;

  const closingSample = trade.status === 'CLOSED' ? trade.lastMarkPrice : null;
  const markPrice = positiveFinite(
    closingSample ?? currentMarkPrice ?? trade.lastMarkPrice,
  );
  if (markPrice === null) return null;

  const directionalEntryDrift =
    plan.side === 'LONG'
      ? actualEntry - plan.entry
      : plan.entry - actualEntry;
  const entryDriftBps = (directionalEntryDrift / plan.entry) * 10_000;

  const favorableDistance = Math.max(
    0,
    plan.side === 'LONG' ? markPrice - actualEntry : actualEntry - markPrice,
  );
  const adverseDistance = Math.max(
    0,
    plan.side === 'LONG' ? actualEntry - markPrice : markPrice - actualEntry,
  );
  const currentMfeBps = (favorableDistance / actualEntry) * 10_000;
  const currentMaeBps = (adverseDistance / actualEntry) * 10_000;
  const currentMfeUsdt = favorableDistance * quantity;
  const currentMaeUsdt = adverseDistance * quantity;
  const mfeBps = maximum(previous?.mfeBps ?? null, currentMfeBps);
  const maeBps = maximum(previous?.maeBps ?? null, currentMaeBps);
  const mfeUsdt = maximum(previous?.mfeUsdt ?? null, currentMfeUsdt);
  const maeUsdt = maximum(previous?.maeUsdt ?? null, currentMaeUsdt);

  const timingQuality = entryTimingQuality(plan.mode, trade.attribution);
  const triggerToTradeOpenMs =
    timingQuality !== 'UNAVAILABLE' &&
    plan.triggeredAt !== null &&
    trade.openedAt !== null &&
    trade.openedAt >= plan.triggeredAt
      ? trade.openedAt - plan.triggeredAt
      : null;
  const holdingEnd = trade.closedAt ?? observedAt;
  const holdingTimeMs =
    trade.openedAt !== null && holdingEnd >= trade.openedAt
      ? holdingEnd - trade.openedAt
      : null;
  const realizedNetR =
    trade.status === 'CLOSED' && trade.realizedNetPnl !== null
      ? trade.realizedNetPnl / initialRiskUsdt
      : null;

  return {
    triggerToTradeOpenMs,
    entryTimingQuality: timingQuality,
    plannedEntry: plan.entry,
    actualEntry,
    entryDriftBps,
    initialRiskUsdt,
    mfeBps,
    maeBps,
    mfeUsdt,
    maeUsdt,
    mfeR: mfeUsdt / initialRiskUsdt,
    maeR: maeUsdt / initialRiskUsdt,
    realizedNetR,
    holdingTimeMs,
    costBasis: costBasis(plan.mode, trade.feesPaid),
    qualityUpdatedAt: observedAt,
  };
}
