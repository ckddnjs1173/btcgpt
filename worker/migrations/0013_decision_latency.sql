ALTER TABLE decision_log ADD COLUMN context_generated_at INTEGER;
ALTER TABLE decision_log ADD COLUMN context_to_record_latency_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_decision_log_context_generated_at
  ON decision_log(context_generated_at, recorded_at);
