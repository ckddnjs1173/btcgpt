# Phase 16B — Experiment Registry and Deterministic Eval Vectors

## Goal

Turn immutable Phase 16 replay cases into reproducible research experiments without enabling paid model calls yet.

Phase 16B answers:

- exactly which model/instruction/context configuration produced a replay output?
- which immutable replay input was used?
- was the model output changed after seeing future data?
- what objective future-path metrics did that output produce?
- what latency/token/cost metadata accompanied the run?

It does not change live trading decisions and does not call OpenAI or another paid model provider.

## Research flow

`experiment config -> finalized replay case -> run start -> model output frozen -> future outcome scoring -> experiment summary`

The important ordering is that the replay output is persisted before the evaluator reads the future outcome.

## Experiment registry

Table: `replay_experiments`

Each immutable experiment config records:

- experiment id and name
- replay version
- evaluator version
- provider
- model and optional model version
- instruction version
- context-pack version
- reasoning/analysis mode
- enabled source set
- SHA-256 of the normalized full experiment config

Enabled sources are deduplicated and sorted before hashing so semantically identical source sets have stable config hashes.

Reusing an experiment id with a different normalized config returns a conflict instead of silently changing history.

## Eval runs

Table: `replay_eval_runs`

A run is keyed by `runId` and binds:

- experiment id
- replay decision id
- trial index
- exact replay input SHA-256
- start time

Only replay cases with a finalized Phase 16 future path can be started. This keeps historical comparisons on a common complete 60-minute observation window.

The combination `(experimentId, decisionId, trialIndex)` is unique. Multiple stochastic trials remain possible by increasing `trialIndex`, but an existing trial cannot be replaced by another run id.

## Output immutability

Replay outputs use `eval-output-v1` and store structured fields only:

- decision
- side
- confidence band
- plan-validation status
- entry/stop/targets when relevant
- trigger/invalidation summaries
- reason and counter-thesis tags
- optional provider response id
- latency
- token usage
- reported/computed cost metadata

No chain-of-thought is stored.

The normalized structured output receives its own SHA-256. Retrying the exact same output is idempotent. Reusing a run id with different output returns `RUN_OUTPUT_CONFLICT`.

Before accepting an output, Phase 16B verifies that the current replay-case payload hash still matches the hash locked when the run started.

## eval-v1 scoring

`eval-v1` deliberately does not create one arbitrary scalar strategy score.

For each 5m / 15m / 30m / 60m future horizon it derives an objective score vector from Phase 16 relay-sampled outcomes.

For LONG or SHORT outputs:

- raw forward return bps
- side-adjusted signed forward return bps
- favorable excursion bps
- adverse excursion bps
- direction-correct boolean

For NEUTRAL outputs:

- raw forward return bps
- maximum absolute opportunity movement bps

The evaluator records that these are relay-sampled Mark Price metrics, not tick-perfect exchange extrema.

### Why there is no scalar score yet

A fixed composite score would require unproven weights between:

- return
- drawdown/adverse excursion
- missed opportunity while abstaining
- latency
- token usage
- monetary API cost

Inventing those weights now would turn the evaluator into a hidden local strategy. Phase 16B therefore preserves the components needed for later cost-adjusted expectancy analysis instead.

## Experiment summary

`GET /v1/replay/experiment/{experimentId}/summary` returns descriptive aggregates:

- total runs
- outputs recorded
- final scores
- 30m directional sample count
- 30m directional accuracy
- average signed 30m return
- neutral/abstain sample count
- average 30m opportunity movement while neutral
- average latency
- reported cost sample count and total reported cost

Directional accuracy is descriptive only. It is explicitly not the promotion objective.

## Research endpoints

All endpoints use the existing Action bearer credential but are intentionally omitted from the live Custom GPT Action schema.

- `POST /v1/replay/experiment/register`
- `POST /v1/replay/run/start`
- `POST /v1/replay/run/{runId}/output`
- `GET /v1/replay/run/{runId}`
- `GET /v1/replay/experiment/{experimentId}/summary`

Phase 16A input/outcome endpoints remain unchanged.

## Leakage boundary

The intended offline runner sequence is:

1. register an immutable experiment config
2. start a run against a finalized replay case
3. fetch `/v1/replay/case/{decisionId}/input`
4. call the selected model or collect a manual replay decision
5. submit the structured output to `/v1/replay/run/{runId}/output`
6. only after persistence does the Worker internally load the future outcome and score it

The caller never needs to fetch the outcome before model output is frozen.

## Paid API boundary

Phase 16B does not add an OpenAI API key, does not enable API billing, and does not make paid model requests.

A later slice can add an OpenAI Responses API runner after explicit approval of the API credential/cost boundary. The registry and scorer are provider-neutral so that runner will not require changing historical experiment semantics.

## Safety

- research/analytics only
- no Binance order create/modify/cancel capability
- no local LONG/SHORT signal
- no scalar strategy score
- no fabricated token or cost values
- unknown cost remains unknown
- no chain-of-thought persistence
- no live Custom GPT schema or instruction change

## Deployment

1. Pull merged main.
2. Apply D1 migration `0009_replay_experiment_registry.sql` remotely.
3. Deploy the Worker.
4. No desktop restart is required.
5. No Custom GPT Action or Instructions edit is required.
