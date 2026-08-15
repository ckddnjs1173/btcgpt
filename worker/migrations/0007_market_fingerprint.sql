CREATE TABLE IF NOT EXISTS snapshot_fingerprint_cache (
  snapshot_id TEXT PRIMARY KEY,
  market_generated_at INTEGER NOT NULL,
  fingerprint_version TEXT NOT NULL,
  feature_count INTEGER NOT NULL,
  present_feature_count INTEGER NOT NULL,
  completeness REAL NOT NULL,
  payload TEXT NOT NULL,
  cached_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshot_fingerprint_cache_cached_at
  ON snapshot_fingerprint_cache(cached_at);

CREATE TABLE IF NOT EXISTS decision_market_fingerprint (
  decision_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  market_generated_at INTEGER NOT NULL,
  fingerprint_version TEXT NOT NULL,
  feature_count INTEGER NOT NULL,
  present_feature_count INTEGER NOT NULL,
  completeness REAL NOT NULL,
  payload TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  FOREIGN KEY(decision_id) REFERENCES decision_log(decision_id)
);

CREATE INDEX IF NOT EXISTS idx_decision_market_fingerprint_snapshot
  ON decision_market_fingerprint(snapshot_id, market_generated_at);

CREATE INDEX IF NOT EXISTS idx_decision_market_fingerprint_linked_at
  ON decision_market_fingerprint(linked_at);
