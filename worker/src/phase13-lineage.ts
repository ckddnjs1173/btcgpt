import type { Env } from './index';
import {
  calculateTradeQuality,
  type TradeQualityPrevious,
} from './phase14-quality';

const PLAN_MATCH_LOOKBACK_MS = 30 * 60_000;
const PLAN_MATCH_FUTURE_TOLERANCE_MS = 60_000;

type RecordLike = Record<string, unknown>;

type DecisionMatchRow = {
  decisionId: string;
  recordedAt: number;
};

type ExistingLineageRow = DecisionMatchRow &
  TradeQualityPrevious & {
    linkedAt: number;
  };

type PlanView = {
  id: string;
  mode: string;
  status: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  targets: number[];
  lockedAt: number;
  estimatedMaxLoss: number | null;
  monitoring: {
    state: string | null;
    triggeredAt: number | null;
    invalidatedAt: number | null;
    expiredAt: number | null;
    cancelledAt: number | null;
  };
};

type TradeView = {
  id: string;
  planId: string;
  status: string;
  entryPrice: number;
  initialQuantity: number;
  openedAt: number | null;
  closedAt: number | null;
  realizedNetPnl: number | null;
  realizedGrossPnl: number | null;
  feesPaid: number | null;
  slippagePaid: number | null;
  fundingPaid: number | null;
  lastMarkPrice: number | null;
  attribution: string | null;
};

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function parsePlan(value: unknown): PlanView | null {
  const plan = asRecord(value);
  if (!plan) return null;
  const id = asString(plan.id);
  const mode = asString(plan.mode);
  const status = asString(plan.status);
  const side = plan.side === 'LONG' || plan.side === 'SHORT' ? plan.side : null;
  const entry = asNumber(plan.entry);
  const stop = asNumber(plan.stop);
  const lockedAt = asNumber(plan.lockedAt);
  const targets = Array.isArray(plan.targets)
    ? plan.targets.map(asNumber).filter((item): item is number => item !== null)
    : [];
  if (
    !id ||
    !mode ||
    !status ||
    !side ||
    entry === null ||
    stop === null ||
    lockedAt === null ||
    targets.length === 0
  )
    return null;

  const monitoring = asRecord(plan.monitoring);
  return {
    id,
    mode,
    status,
    side,
    entry,
    stop,
    targets,
    lockedAt,
    estimatedMaxLoss: asNullableNumber(plan.estimatedMaxLoss),
    monitoring: {
      state: asString(monitoring?.state),
      triggeredAt: asNullableNumber(monitoring?.triggeredAt),
      invalidatedAt: asNullableNumber(monitoring?.invalidatedAt),
      expiredAt: asNullableNumber(monitoring?.expiredAt),
      cancelledAt: asNullableNumber(monitoring?.cancelledAt),
    },
  };
}

function parseTrade(value: unknown): TradeView | null {
  const trade = asRecord(value);
  if (!trade) return null;
  const id = asString(trade.id);
  const planId = asString(trade.planId);
  const status = asString(trade.status);
  const entryPrice = asNumber(trade.entryPrice);
  const initialQuantity = asNumber(trade.initialQuantity);
  if (
    !id ||
    !planId ||
    !status ||
    entryPrice === null ||
    initialQuantity === null
  )
    return null;
  return {
    id,
    planId,
    status,
    entryPrice,
    initialQuantity,
    openedAt: asNullableNumber(trade.openedAt),
    closedAt: asNullableNumber(trade.closedAt),
    realizedNetPnl: asNullableNumber(trade.realizedNetPnl),
    realizedGrossPnl: asNullableNumber(trade.realizedGrossPnl),
    feesPaid: asNullableNumber(trade.feesPaid),
    slippagePaid: asNullableNumber(trade.slippagePaid),
    fundingPaid: asNullableNumber(trade.fundingPaid),
    lastMarkPrice: asNullableNumber(trade.lastMarkPrice),
    attribution: asString(trade.attribution),
  };
}

function uniqueById<T extends { id: string }>(items: Array<T | null>): T[] {
  const result = new Map<string, T>();
  for (const item of items) if (item) result.set(item.id, item);
  return [...result.values()];
}

async function findExistingLineage(
  env: Env,
  planId: string,
): Promise<ExistingLineageRow | null> {
  return env
    .DB!.prepare(
      `SELECT lineage.decision_id AS decisionId,
        lineage.linked_at AS linkedAt,
        decision.recorded_at AS recordedAt,
        lineage.actual_entry AS actualEntry,
        lineage.mfe_bps AS mfeBps,
        lineage.mae_bps AS maeBps,
        lineage.mfe_usdt AS mfeUsdt,
        lineage.mae_usdt AS maeUsdt
       FROM decision_trade_lineage AS lineage
       JOIN decision_log AS decision
         ON decision.decision_id = lineage.decision_id
       WHERE lineage.plan_id = ?`,
    )
    .bind(planId)
    .first<ExistingLineageRow>();
}

async function findMatchingDecision(
  env: Env,
  plan: PlanView,
): Promise<DecisionMatchRow | null> {
  return env
    .DB!.prepare(
      `SELECT decision_id AS decisionId, recorded_at AS recordedAt
       FROM decision_log
       WHERE decision = 'ENTER_NOW'
         AND side = ?
         AND plan_validation = 'VALIDATED'
         AND entry = ?
         AND stop = ?
         AND targets_json = ?
         AND recorded_at >= ?
         AND recorded_at <= ?
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .bind(
      plan.side,
      plan.entry,
      plan.stop,
      JSON.stringify(plan.targets),
      plan.lockedAt - PLAN_MATCH_LOOKBACK_MS,
      plan.lockedAt + PLAN_MATCH_FUTURE_TOLERANCE_MS,
    )
    .first<DecisionMatchRow>();
}

async function upsertLineage(
  env: Env,
  input: {
    decisionId: string;
    decisionRecordedAt: number;
    linkedAt: number;
    plan: PlanView;
    trade: TradeView | null;
    currentMarkPrice: number | null;
    previous: TradeQualityPrevious | null;
    observedAt: number;
  },
): Promise<void> {
  const {
    decisionId,
    decisionRecordedAt,
    linkedAt,
    plan,
    trade,
    currentMarkPrice,
    previous,
    observedAt,
  } = input;
  const decisionToPlanLockMs =
    plan.lockedAt >= decisionRecordedAt
      ? plan.lockedAt - decisionRecordedAt
      : null;
  const quality = trade
    ? calculateTradeQuality({
        plan: {
          mode: plan.mode,
          side: plan.side,
          entry: plan.entry,
          stop: plan.stop,
          estimatedMaxLoss: plan.estimatedMaxLoss,
          triggeredAt: plan.monitoring.triggeredAt,
        },
        trade,
        currentMarkPrice,
        previous,
        observedAt,
      })
    : null;
  const payload = JSON.stringify({
    plan: {
      id: plan.id,
      mode: plan.mode,
      status: plan.status,
      side: plan.side,
      entry: plan.entry,
      stop: plan.stop,
      targets: plan.targets,
      lockedAt: plan.lockedAt,
      monitoring: plan.monitoring,
    },
    trade: trade
      ? {
          id: trade.id,
          planId: trade.planId,
          status: trade.status,
          entryPrice: trade.entryPrice,
          initialQuantity: trade.initialQuantity,
          openedAt: trade.openedAt,
          closedAt: trade.closedAt,
          realizedNetPnl: trade.realizedNetPnl,
          realizedGrossPnl: trade.realizedGrossPnl,
          feesPaid: trade.feesPaid,
          slippagePaid: trade.slippagePaid,
          fundingPaid: trade.fundingPaid,
          lastMarkPrice: trade.lastMarkPrice,
          attribution: trade.attribution,
        }
      : null,
    quality,
  });
  const result = await env
    .DB!.prepare(
      `INSERT INTO decision_trade_lineage (
        decision_id, plan_id, mode, link_method, linked_at,
        plan_locked_at, plan_status, monitoring_state, triggered_at,
        invalidated_at, expired_at, cancelled_at, trade_id, trade_status,
        trade_opened_at, trade_closed_at, realized_net_pnl,
        realized_gross_pnl, fees_paid, slippage_paid, funding_paid,
        decision_to_plan_lock_ms, trigger_to_trade_open_ms,
        entry_timing_quality, planned_entry, actual_entry, entry_drift_bps,
        initial_risk_usdt, mfe_bps, mae_bps, mfe_usdt, mae_usdt, mfe_r,
        mae_r, realized_net_r, holding_time_ms, cost_basis,
        quality_updated_at, last_observed_at, payload
      ) VALUES (
        ?, ?, ?, 'PLAN_VALUES_EXACT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?
      )
      ON CONFLICT(decision_id) DO UPDATE SET
        plan_id=excluded.plan_id,
        mode=excluded.mode,
        plan_status=excluded.plan_status,
        monitoring_state=excluded.monitoring_state,
        triggered_at=COALESCE(excluded.triggered_at, decision_trade_lineage.triggered_at),
        invalidated_at=COALESCE(excluded.invalidated_at, decision_trade_lineage.invalidated_at),
        expired_at=COALESCE(excluded.expired_at, decision_trade_lineage.expired_at),
        cancelled_at=COALESCE(excluded.cancelled_at, decision_trade_lineage.cancelled_at),
        trade_id=COALESCE(excluded.trade_id, decision_trade_lineage.trade_id),
        trade_status=COALESCE(excluded.trade_status, decision_trade_lineage.trade_status),
        trade_opened_at=COALESCE(excluded.trade_opened_at, decision_trade_lineage.trade_opened_at),
        trade_closed_at=COALESCE(excluded.trade_closed_at, decision_trade_lineage.trade_closed_at),
        realized_net_pnl=COALESCE(excluded.realized_net_pnl, decision_trade_lineage.realized_net_pnl),
        realized_gross_pnl=COALESCE(excluded.realized_gross_pnl, decision_trade_lineage.realized_gross_pnl),
        fees_paid=COALESCE(excluded.fees_paid, decision_trade_lineage.fees_paid),
        slippage_paid=COALESCE(excluded.slippage_paid, decision_trade_lineage.slippage_paid),
        funding_paid=COALESCE(excluded.funding_paid, decision_trade_lineage.funding_paid),
        decision_to_plan_lock_ms=COALESCE(decision_trade_lineage.decision_to_plan_lock_ms, excluded.decision_to_plan_lock_ms),
        trigger_to_trade_open_ms=COALESCE(decision_trade_lineage.trigger_to_trade_open_ms, excluded.trigger_to_trade_open_ms),
        entry_timing_quality=COALESCE(excluded.entry_timing_quality, decision_trade_lineage.entry_timing_quality),
        planned_entry=COALESCE(decision_trade_lineage.planned_entry, excluded.planned_entry),
        actual_entry=COALESCE(decision_trade_lineage.actual_entry, excluded.actual_entry),
        entry_drift_bps=COALESCE(decision_trade_lineage.entry_drift_bps, excluded.entry_drift_bps),
        initial_risk_usdt=COALESCE(decision_trade_lineage.initial_risk_usdt, excluded.initial_risk_usdt),
        mfe_bps=COALESCE(excluded.mfe_bps, decision_trade_lineage.mfe_bps),
        mae_bps=COALESCE(excluded.mae_bps, decision_trade_lineage.mae_bps),
        mfe_usdt=COALESCE(excluded.mfe_usdt, decision_trade_lineage.mfe_usdt),
        mae_usdt=COALESCE(excluded.mae_usdt, decision_trade_lineage.mae_usdt),
        mfe_r=COALESCE(excluded.mfe_r, decision_trade_lineage.mfe_r),
        mae_r=COALESCE(excluded.mae_r, decision_trade_lineage.mae_r),
        realized_net_r=COALESCE(excluded.realized_net_r, decision_trade_lineage.realized_net_r),
        holding_time_ms=COALESCE(excluded.holding_time_ms, decision_trade_lineage.holding_time_ms),
        cost_basis=COALESCE(excluded.cost_basis, decision_trade_lineage.cost_basis),
        quality_updated_at=COALESCE(excluded.quality_updated_at, decision_trade_lineage.quality_updated_at),
        last_observed_at=excluded.last_observed_at,
        payload=excluded.payload`,
    )
    .bind(
      decisionId,
      plan.id,
      plan.mode,
      linkedAt,
      plan.lockedAt,
      plan.status,
      plan.monitoring.state,
      plan.monitoring.triggeredAt,
      plan.monitoring.invalidatedAt,
      plan.monitoring.expiredAt,
      plan.monitoring.cancelledAt,
      trade?.id ?? null,
      trade?.status ?? null,
      trade?.openedAt ?? null,
      trade?.closedAt ?? null,
      trade?.realizedNetPnl ?? null,
      trade?.realizedGrossPnl ?? null,
      trade?.feesPaid ?? null,
      trade?.slippagePaid ?? null,
      trade?.fundingPaid ?? null,
      decisionToPlanLockMs,
      quality?.triggerToTradeOpenMs ?? null,
      quality?.entryTimingQuality ?? null,
      quality?.plannedEntry ?? null,
      quality?.actualEntry ?? null,
      quality?.entryDriftBps ?? null,
      quality?.initialRiskUsdt ?? null,
      quality?.mfeBps ?? null,
      quality?.maeBps ?? null,
      quality?.mfeUsdt ?? null,
      quality?.maeUsdt ?? null,
      quality?.mfeR ?? null,
      quality?.maeR ?? null,
      quality?.realizedNetR ?? null,
      quality?.holdingTimeMs ?? null,
      quality?.costBasis ?? null,
      quality?.qualityUpdatedAt ?? null,
      observedAt,
      payload,
    )
    .run();
  if (!result.success) throw new Error('D1_LINEAGE_WRITE_FAILED');
}

export async function syncDecisionLineageFromSnapshot(
  env: Env,
  snapshot: unknown,
  observedAt = Date.now(),
): Promise<number> {
  if (!env.DB) return 0;
  const root = asRecord(snapshot);
  const trading = asRecord(root?.trading);
  if (!trading) return 0;
  const marketState = asRecord(root?.marketState);
  const currentMarkPrice = asNullableNumber(marketState?.markPrice);

  const plans = uniqueById([
    parsePlan(trading.activePlan),
    parsePlan(trading.lastPlan),
  ]);
  const liveManual = asRecord(trading.liveManual);
  const trades = uniqueById([
    parseTrade(trading.activePaperTrade),
    parseTrade(trading.lastCompletedPaperTrade),
    parseTrade(trading.activeLiveTrade),
    parseTrade(trading.lastCompletedLiveTrade),
    parseTrade(liveManual?.currentTrade),
    parseTrade(liveManual?.lastCompletedTrade),
  ]);

  let linkedOrUpdated = 0;
  for (const plan of plans) {
    const existing = await findExistingLineage(env, plan.id);
    const match = existing ?? (await findMatchingDecision(env, plan));
    if (!match) continue;
    const trade =
      trades.find((candidate) => candidate.planId === plan.id) ?? null;
    await upsertLineage(env, {
      decisionId: match.decisionId,
      decisionRecordedAt: match.recordedAt,
      linkedAt: existing?.linkedAt ?? observedAt,
      plan,
      trade,
      currentMarkPrice,
      previous: existing
        ? {
            actualEntry: existing.actualEntry,
            mfeBps: existing.mfeBps,
            maeBps: existing.maeBps,
            mfeUsdt: existing.mfeUsdt,
            maeUsdt: existing.maeUsdt,
          }
        : null,
      observedAt,
    });
    linkedOrUpdated += 1;
  }
  return linkedOrUpdated;
}
