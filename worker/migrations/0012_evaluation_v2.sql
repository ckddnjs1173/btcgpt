ALTER TABLE replay_case_outcomes ADD COLUMN max_up_bps_1m REAL;
ALTER TABLE replay_case_outcomes ADD COLUMN max_down_bps_1m REAL;
ALTER TABLE replay_case_outcomes ADD COLUMN return_bps_1m REAL;
ALTER TABLE replay_case_outcomes ADD COLUMN return_observed_at_1m INTEGER;

ALTER TABLE replay_case_outcomes ADD COLUMN max_up_bps_3m REAL;
ALTER TABLE replay_case_outcomes ADD COLUMN max_down_bps_3m REAL;
ALTER TABLE replay_case_outcomes ADD COLUMN return_bps_3m REAL;
ALTER TABLE replay_case_outcomes ADD COLUMN return_observed_at_3m INTEGER;

ALTER TABLE replay_case_outcomes ADD COLUMN price_path_version TEXT NOT NULL DEFAULT 'path-v1';
ALTER TABLE replay_case_outcomes ADD COLUMN price_path_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE replay_case_outcomes ADD COLUMN last_path_observed_at INTEGER;
