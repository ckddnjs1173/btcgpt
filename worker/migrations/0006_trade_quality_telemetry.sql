ALTER TABLE decision_trade_lineage ADD COLUMN decision_to_plan_lock_ms INTEGER;
ALTER TABLE decision_trade_lineage ADD COLUMN trigger_to_trade_open_ms INTEGER;
ALTER TABLE decision_trade_lineage ADD COLUMN entry_timing_quality TEXT;
ALTER TABLE decision_trade_lineage ADD COLUMN planned_entry REAL;
ALTER TABLE decision_trade_lineage ADD COLUMN actual_entry REAL;
ALTER TABLE decision_trade_lineage ADD COLUMN entry_drift_bps REAL;
ALTER TABLE decision_trade_lineage ADD COLUMN initial_risk_usdt REAL;
ALTER TABLE decision_trade_lineage ADD COLUMN mfe_bps REAL;
ALTER TABLE decision_trade_lineage ADD COLUMN mae_bps REAL;
ALTER TABLE decision_trade_lineage ADD COLUMN mfe_usdt REAL;
ALTER TABLE decision_trade_lineage ADD COLUMN mae_usdt REAL;
ALTER TABLE decision_trade_lineage ADD COLUMN mfe_r REAL;
ALTER TABLE decision_trade_lineage ADD COLUMN mae_r REAL;
ALTER TABLE decision_trade_lineage ADD COLUMN realized_net_r REAL;
ALTER TABLE decision_trade_lineage ADD COLUMN holding_time_ms INTEGER;
ALTER TABLE decision_trade_lineage ADD COLUMN cost_basis TEXT;
ALTER TABLE decision_trade_lineage ADD COLUMN quality_updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_decision_trade_lineage_quality_updated
  ON decision_trade_lineage(quality_updated_at);
