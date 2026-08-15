CREATE TABLE IF NOT EXISTS replay_experiments (
  experiment_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  replay_version TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT,
  instruction_version TEXT NOT NULL,
  context_pack_version TEXT NOT NULL,
  analysis_mode TEXT NOT NULL,
  enabled_sources_json TEXT NOT NULL,
  config_sha256 TEXT NOT NULL,
  config_payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_replay_experiments_created
  ON replay_experiments(created_at);

CREATE INDEX IF NOT EXISTS idx_replay_experiments_config
  ON replay_experiments(config_sha256);

CREATE TABLE IF NOT EXISTS replay_eval_runs (
  run_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  trial_index INTEGER NOT NULL DEFAULT 1,
  replay_input_sha256 TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  output_recorded_at INTEGER,
  completed_at INTEGER,
  status TEXT NOT NULL,
  output_payload_sha256 TEXT,
  output_payload TEXT,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_input_tokens INTEGER,
  reported_cost_usd REAL,
  cost_basis TEXT NOT NULL DEFAULT 'UNKNOWN',
  evaluator_version TEXT NOT NULL,
  score_status TEXT NOT NULL DEFAULT 'PENDING',
  score_payload TEXT,
  signed_return_bps_30m REAL,
  direction_correct_30m INTEGER,
  opportunity_bps_30m REAL,
  FOREIGN KEY(experiment_id) REFERENCES replay_experiments(experiment_id),
  FOREIGN KEY(decision_id) REFERENCES replay_cases(decision_id),
  UNIQUE(experiment_id, decision_id, trial_index)
);

CREATE INDEX IF NOT EXISTS idx_replay_eval_runs_experiment
  ON replay_eval_runs(experiment_id, status, completed_at);

CREATE INDEX IF NOT EXISTS idx_replay_eval_runs_decision
  ON replay_eval_runs(decision_id);

CREATE INDEX IF NOT EXISTS idx_replay_eval_runs_score
  ON replay_eval_runs(experiment_id, score_status, direction_correct_30m);
