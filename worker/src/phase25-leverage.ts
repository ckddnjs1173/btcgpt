import type { Env } from './index';

type RecordLike = Record<string, unknown>;

type PlanLeverage = {
  planId: string;
  leverage: number;
};

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function parsePlanLeverage(value: unknown): PlanLeverage | null {
  const plan = asRecord(value);
  if (!plan) return null;
  const planId = typeof plan.id === 'string' ? plan.id : null;
  const leverage =
    typeof plan.leverage === 'number' &&
    Number.isFinite(plan.leverage) &&
    plan.leverage > 0
      ? plan.leverage
      : null;
  if (!planId || leverage === null) return null;
  return { planId, leverage };
}

export async function capturePlanLeverageFromSnapshot(
  env: Env,
  snapshot: unknown,
): Promise<number> {
  if (!env.DB) return 0;
  const root = asRecord(snapshot);
  const trading = asRecord(root?.trading);
  if (!trading) return 0;

  const plans = new Map<string, PlanLeverage>();
  for (const candidate of [trading.activePlan, trading.lastPlan]) {
    const parsed = parsePlanLeverage(candidate);
    if (parsed) plans.set(parsed.planId, parsed);
  }

  let captured = 0;
  for (const plan of plans.values()) {
    const result = await env.DB.prepare(
      `UPDATE decision_trade_lineage
       SET plan_leverage = ?,
         payload = json_set(payload, '$.plan.leverage', ?)
       WHERE plan_id = ?`,
    )
      .bind(plan.leverage, plan.leverage, plan.planId)
      .run();
    if (!result.success) throw new Error('D1_PLAN_LEVERAGE_WRITE_FAILED');
    captured += 1;
  }
  return captured;
}
