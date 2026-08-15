ALTER TABLE decision_trade_lineage ADD COLUMN plan_leverage REAL;

CREATE INDEX IF NOT EXISTS idx_decision_trade_lineage_plan_leverage
  ON decision_trade_lineage(plan_leverage, trade_closed_at);

CREATE TRIGGER IF NOT EXISTS trg_lineage_plan_leverage_insert
AFTER INSERT ON decision_trade_lineage
BEGIN
  UPDATE decision_trade_lineage
  SET
    plan_leverage = COALESCE(
      CASE
        WHEN json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.activePlan.id') = NEW.plan_id
        THEN CAST(json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.activePlan.leverage') AS REAL)
      END,
      CASE
        WHEN json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.lastPlan.id') = NEW.plan_id
        THEN CAST(json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.lastPlan.leverage') AS REAL)
      END
    ),
    payload = CASE
      WHEN COALESCE(
        CASE
          WHEN json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.activePlan.id') = NEW.plan_id
          THEN CAST(json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.activePlan.leverage') AS REAL)
        END,
        CASE
          WHEN json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.lastPlan.id') = NEW.plan_id
          THEN CAST(json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.lastPlan.leverage') AS REAL)
        END
      ) IS NOT NULL
      THEN json_set(
        payload,
        '$.plan.leverage',
        COALESCE(
          CASE
            WHEN json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.activePlan.id') = NEW.plan_id
            THEN CAST(json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.activePlan.leverage') AS REAL)
          END,
          CASE
            WHEN json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.lastPlan.id') = NEW.plan_id
            THEN CAST(json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.lastPlan.leverage') AS REAL)
          END
        )
      )
      ELSE payload
    END
  WHERE decision_id = NEW.decision_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_lineage_plan_leverage_update
AFTER UPDATE OF plan_id, last_observed_at ON decision_trade_lineage
BEGIN
  UPDATE decision_trade_lineage
  SET
    plan_leverage = COALESCE(
      plan_leverage,
      CASE
        WHEN json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.activePlan.id') = NEW.plan_id
        THEN CAST(json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.activePlan.leverage') AS REAL)
      END,
      CASE
        WHEN json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.lastPlan.id') = NEW.plan_id
        THEN CAST(json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.lastPlan.leverage') AS REAL)
      END
    ),
    payload = CASE
      WHEN json_extract(payload, '$.plan.leverage') IS NULL
        AND COALESCE(
          CASE
            WHEN json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.activePlan.id') = NEW.plan_id
            THEN CAST(json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.activePlan.leverage') AS REAL)
          END,
          CASE
            WHEN json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.lastPlan.id') = NEW.plan_id
            THEN CAST(json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.lastPlan.leverage') AS REAL)
          END
        ) IS NOT NULL
      THEN json_set(
        payload,
        '$.plan.leverage',
        COALESCE(
          CASE
            WHEN json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.activePlan.id') = NEW.plan_id
            THEN CAST(json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.activePlan.leverage') AS REAL)
          END,
          CASE
            WHEN json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.lastPlan.id') = NEW.plan_id
            THEN CAST(json_extract((SELECT payload FROM latest_snapshot WHERE id = 1), '$.trading.lastPlan.leverage') AS REAL)
          END
        )
      )
      ELSE payload
    END
  WHERE decision_id = NEW.decision_id;
END;
