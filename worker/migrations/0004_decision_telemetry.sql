CREATE TABLE IF NOT EXISTS decision_log (
  decision_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  market_generated_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  intent TEXT NOT NULL,
  decision TEXT NOT NULL,
  side TEXT NOT NULL,
  analysis_mode TEXT NOT NULL,
  instruction_version TEXT NOT NULL,
  context_pack_version TEXT NOT NULL,
  confidence_band TEXT NOT NULL,
  parent_decision_id TEXT,
  snapshot_status TEXT NOT NULL,
  snapshot_to_record_latency_ms INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_log_recorded_at
  ON decision_log(recorded_at);

CREATE INDEX IF NOT EXISTS idx_decision_log_snapshot_id
  ON decision_log(snapshot_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_decision_log_parent_decision_id
  ON decision_log(parent_decision_id);
