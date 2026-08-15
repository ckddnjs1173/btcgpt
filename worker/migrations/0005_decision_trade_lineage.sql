ALTER TABLE decision_log ADD COLUMN plan_validation TEXT NOT NULL DEFAULT 'NOT_APPLICABLE';
ALTER TABLE decision_log ADD COLUMN entry REAL;
ALTER TABLE decision_log ADD COLUMN stop REAL;
ALTER TABLE decision_log ADD COLUMN targets_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_decision_log_trade_match
  ON decision_log(decision, side, plan_validation, recorded_at);

CREATE TABLE IF NOT EXISTS decision_trade_lineage (
  decision_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  link_method TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  plan_locked_at INTEGER NOT NULL,
  plan_status TEXT NOT NULL,
  monitoring_state TEXT,
  triggered_at INTEGER,
  invalidated_at INTEGER,
  expired_at INTEGER,
  cancelled_at INTEGER,
  trade_id TEXT,
  trade_status TEXT,
  trade_opened_at INTEGER,
  trade_closed_at INTEGER,
  realized_net_pnl REAL,
  realized_gross_pnl REAL,
  fees_paid REAL,
  slippage_paid REAL,
  funding_paid REAL,
  last_observed_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  FOREIGN KEY(decision_id) REFERENCES decision_log(decision_id)
);

CREATE INDEX IF NOT EXISTS idx_decision_trade_lineage_plan_id
  ON decision_trade_lineage(plan_id);

CREATE INDEX IF NOT EXISTS idx_decision_trade_lineage_trade_id
  ON decision_trade_lineage(trade_id);

CREATE INDEX IF NOT EXISTS idx_decision_trade_lineage_last_observed
  ON decision_trade_lineage(last_observed_at);
