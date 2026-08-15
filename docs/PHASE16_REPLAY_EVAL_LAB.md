# Phase 16 — Historical Replay / Eval Lab

## Goal

Create a leakage-resistant historical replay foundation so the same past market state can later be re-run against different GPT models, prompts, reasoning modes, context packs, and data-source combinations.

Phase 16 does not change live trading decisions. It creates immutable research inputs and separately accumulated future outcomes.

## Core rule

Replay input and future outcome are stored and served separately.

`PAST INPUT -> GPT REPLAY -> OUTPUT -> OUTCOME SCORING`

Future data must never be included in the replay input that a model receives.

## Exact snapshot leasing

The relay uploads a new compact snapshot every few seconds, but Phase 16 does not permanently duplicate every relay snapshot.

Instead, when GPT actually calls `GET /v1/snapshot/latest`, the Worker stores the exact Action response in a short-lived replay lease:

`getLatestSnapshot -> replay_snapshot_lease`

The leased payload is the response GPT actually received after relay freshness gates and risk-context enrichment were applied.

Lease TTL: 30 minutes.

This means snapshots GPT never viewed are not retained merely for replay storage.

## Decision promotion

When `recordDecision` arrives, the Worker looks up the lease by exact:

- `snapshotId`
- `marketGeneratedAt`

If it exists, the snapshot is promoted into `replay_cases` and permanently keyed by `decisionId`.

Replay cases are immutable. A later lease for the same snapshot cannot overwrite an already-captured decision replay input.

The replay case stores:

- replay version (`replay-v1`)
- decision id
- snapshot id
- market generated time
- source lease time
- capture time
- anchor mark price
- payload bytes
- SHA-256 of the exact snapshot payload
- exact snapshot payload

`recordDecision` remains authoritative even if replay enrichment is unavailable. Replay capture is analytics-only.

## Future path outcome sampling

Every later compact relay snapshot updates pending replay outcomes using Mark Price.

For each replay case, Phase 16 records objective path statistics at:

- 5 minutes
- 15 minutes
- 30 minutes
- 60 minutes

For every horizon:

- forward return in bps
- maximum upward excursion in bps
- maximum downward excursion in bps
- timestamp of the first relay sample used for the horizon return

It also records:

- first/last future sample timestamps
- sample count
- finalization timestamp

The horizon return is the first available relay sample at or after the requested horizon. Maximum up/down values use relay samples observed up to that horizon.

These are relay-sampled path labels, not tick-perfect Binance extrema.

## Why max-up / max-down instead of direction-aware MFE/MAE

Replay outcomes are intentionally direction-neutral.

A `NO_TRADE`, `WAIT_TRIGGER`, LONG replay, and SHORT replay must be scoreable from the same objective market path. Direction-specific favorable/adverse excursion can be derived later from max-up/max-down according to the replayed decision side.

Trade-specific MFE/MAE and Net R remain Phase 14 metrics in `decision_trade_lineage`.

## Leakage boundary

Research reads are split into two authenticated endpoints that are deliberately not added to the live Custom GPT Action schema.

### Replay input

`GET /v1/replay/case/{decisionId}/input`

Returns only information that belongs to the replay input:

- exact captured snapshot
- payload hash/size metadata
- objective Market Fingerprint when available

It does not return the original GPT decision, future returns, or realized trade outcome.

### Replay outcome

`GET /v1/replay/case/{decisionId}/outcome`

Returns scoring-only information:

- original structured decision metadata
- future relay-sampled path
- linked Phase 14 trade-quality metrics when present

An evaluation runner must call the input endpoint first, complete and freeze the model output, and only then read the outcome endpoint for scoring.

## SUPERSEDED decisions

Phase 13 correctly permits a decision to be recorded as `SUPERSEDED` when a newer relay snapshot arrived while GPT was reasoning.

Phase 16 solves replay accuracy for this case by leasing the snapshot at the moment GPT fetched it. The replay case therefore does not need to reconstruct the older input from the newest `latest_snapshot` row.

## Research integrity

- Replay input is immutable after capture.
- Exact payload SHA-256 is stored for reproducibility.
- Future labels are stored separately from model inputs.
- Missing replay leases are left missing rather than reconstructed from future/newer data.
- Future paths are objective Mark Price observations, not local directional labels.
- No chain-of-thought is stored.
- No local LONG/SHORT score is created.
- No Binance order create/modify/cancel capability is added.

## Next slice

With replay cases available, the next Phase 16 slice can add an offline experiment runner and eval registry that records:

- model/version
- instruction version
- context-pack version
- reasoning mode
- enabled data-source set
- replay decision
- latency/token/cost metadata
- deterministic score against the separately fetched outcome

That runner can then compare variants on the same frozen replay cases before any change is promoted to live trading.

## Deployment

1. Pull the merged code.
2. Apply D1 migration `0008_replay_eval_lab.sql` remotely.
3. Deploy the Worker.
4. No desktop application restart is required.
5. No Custom GPT Action schema or Instructions change is required for this slice.
