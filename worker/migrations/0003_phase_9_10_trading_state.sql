CREATE TABLE IF NOT EXISTS latest_trading_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_latest_trading_state_generated
  ON latest_trading_state(generated_at);
