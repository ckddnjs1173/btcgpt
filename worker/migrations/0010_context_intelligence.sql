CREATE TABLE IF NOT EXISTS cross_market_latest (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cross_market_latest_generated
  ON cross_market_latest(generated_at);

CREATE TABLE IF NOT EXISTS decision_context_pack (
  decision_id TEXT PRIMARY KEY,
  context_pack_version TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  market_generated_at INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload TEXT NOT NULL,
  FOREIGN KEY(decision_id) REFERENCES decision_log(decision_id)
);

CREATE INDEX IF NOT EXISTS idx_decision_context_pack_market_time
  ON decision_context_pack(market_generated_at);

CREATE INDEX IF NOT EXISTS idx_decision_context_pack_version
  ON decision_context_pack(context_pack_version, generated_at);
