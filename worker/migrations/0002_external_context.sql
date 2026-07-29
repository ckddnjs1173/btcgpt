CREATE TABLE IF NOT EXISTS external_context_payloads (
  horizon TEXT PRIMARY KEY CHECK (horizon IN ('INTRADAY', 'SWING', 'MACRO')),
  payload TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS external_context_summary (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_external_context_generated
  ON external_context_payloads(generated_at);
