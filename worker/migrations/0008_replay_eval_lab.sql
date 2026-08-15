CREATE TABLE IF NOT EXISTS replay_snapshot_lease (
  snapshot_id TEXT PRIMARY KEY,
  market_generated_at INTEGER NOT NULL,
  leased_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  payload_bytes INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_replay_snapshot_lease_expires
  ON replay_snapshot_lease(expires_at);

CREATE TABLE IF NOT EXISTS replay_cases (
  decision_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  market_generated_at INTEGER NOT NULL,
  replay_version TEXT NOT NULL,
  source_lease_at INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  anchor_mark_price REAL,
  payload_bytes INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  snapshot_payload TEXT NOT NULL,
  FOREIGN KEY(decision_id) REFERENCES decision_log(decision_id)
);

CREATE INDEX IF NOT EXISTS idx_replay_cases_market_time
  ON replay_cases(market_generated_at);

CREATE INDEX IF NOT EXISTS idx_replay_cases_snapshot
  ON replay_cases(snapshot_id, market_generated_at);

CREATE TABLE IF NOT EXISTS replay_case_outcomes (
  decision_id TEXT PRIMARY KEY,
  market_generated_at INTEGER NOT NULL,
  anchor_mark_price REAL,
  first_future_observed_at INTEGER,
  last_future_observed_at INTEGER,
  sample_count INTEGER NOT NULL DEFAULT 0,

  max_up_bps_5m REAL,
  max_down_bps_5m REAL,
  return_bps_5m REAL,
  return_observed_at_5m INTEGER,

  max_up_bps_15m REAL,
  max_down_bps_15m REAL,
  return_bps_15m REAL,
  return_observed_at_15m INTEGER,

  max_up_bps_30m REAL,
  max_down_bps_30m REAL,
  return_bps_30m REAL,
  return_observed_at_30m INTEGER,

  max_up_bps_60m REAL,
  max_down_bps_60m REAL,
  return_bps_60m REAL,
  return_observed_at_60m INTEGER,

  finalized_at INTEGER,
  FOREIGN KEY(decision_id) REFERENCES replay_cases(decision_id)
);

CREATE INDEX IF NOT EXISTS idx_replay_case_outcomes_pending
  ON replay_case_outcomes(finalized_at, market_generated_at);
