ALTER TABLE decision_trade_lineage ADD COLUMN plan_leverage REAL;

CREATE INDEX IF NOT EXISTS idx_decision_trade_lineage_plan_leverage
  ON decision_trade_lineage(plan_leverage, trade_closed_at);
