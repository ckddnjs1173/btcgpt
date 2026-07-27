CREATE TABLE IF NOT EXISTS latest_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
