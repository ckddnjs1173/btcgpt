# Research Batch — Phase 24-25

## Scope

This batch completes the research-side foundation for comparing the live Custom GPT with an OpenAI API research agent and for studying performance-aware sizing without changing live trade execution.

## Phase 24 — Live Custom GPT vs API research-agent benchmark

The live Custom GPT remains the production decision path. API research runs are evaluated on the exact frozen replay cases captured from live decisions.

### Research endpoints

- `GET /v1/research/benchmark/{experimentId}`
  - requires the existing `ACTION_READ_KEY` Bearer authentication
  - matches scored replay runs against the original `decision_log` row by `decisionId`
  - reports decision/side agreement
  - compares 30-minute directional correctness and signed return bps
  - compares WAIT/NO_TRADE missed-opportunity magnitude
  - reports live decision latency and API latency where available
  - reports API cost only where a run supplied a real cost value
  - reports actual cost-adjusted `realizedNetR` only for linked executed trades

Replay signed-return bps are not labeled as realized Net R. There is no automatic model promotion. The benchmark only becomes `READY_FOR_MANUAL_REVIEW` after at least 50 matched cases and at least 20 directional cases per arm.

### OpenAI replay execution

Existing sequential replay remains available through `npm run replay:run` and still requires both `OPENAI_API_KEY` and `ALLOW_PAID_REPLAY=YES`.

This batch adds a no-cost preparation path:

- `npm run replay:batch:prepare -- <experiment.json> [output-prefix]`
  - reads frozen replay inputs from the relay
  - registers the research experiment
  - writes an OpenAI Batch-compatible `/v1/responses` JSONL file
  - writes a local manifest mapping `custom_id -> decisionId/runId`
  - does not call the OpenAI API
- `npm run replay:batch:ingest -- <manifest.json> <batch-output.jsonl>`
  - ingests completed Batch output into the existing replay/eval registry
  - does not calculate or invent API price/cost data

Paid Batch submission itself is intentionally not automated here. It requires explicit user approval before any API spend.

## Phase 25 — Performance-aware sizing/leverage research

- `GET /v1/research/performance-sizing`
  - requires existing Action Bearer auth
  - uses only closed decision-linked trades with non-null `realized_net_r`
  - computes mean/median Net R, win rate, volatility, one-sided lower confidence bound, 10th percentile, R drawdown, entry drift and MFE/MAE summaries
  - groups descriptive cohorts by analysis mode, confidence band, context pack version and observed leverage bucket

Migration `0011_performance_research.sql` adds `plan_leverage` telemetry to decision/trade lineage and captures leverage from the matching active/last locked plan as lineage continues to update. Existing historical trades can remain `UNKNOWN` when their plan is no longer present in a current snapshot; the system never invents leverage for those rows.

A bounded `candidateRiskMultiplier` is produced only after at least 30 closed trades. It uses shrinkage toward zero and a one-sided confidence bound, and is capped at `1.2x`. This value is research evidence only.

Observed leverage cohorts are descriptive because leverage is confounded with setup, stop distance, margin and liquidation constraints. This batch deliberately does not output an automatic leverage recommendation.

## Safety and promotion boundary

- no Binance create/modify/cancel/withdraw/transfer capability
- no live size or leverage mutation
- no local LONG/SHORT decision engine
- no automatic Custom GPT -> API agent promotion
- no paid OpenAI request without explicit approval
- no replay directional-return metric is relabeled as actual Net R
- user-entered size/leverage remains authoritative

The research endpoints are not added to the Custom GPT Action schema. They are operator/research tools and are intentionally separated from the live GPT decision context.

## Deployment

This batch adds one D1 migration and no desktop runtime change.

After merge:

1. `git pull origin main`
2. `npx wrangler d1 migrations list DB --remote`
3. `npx wrangler d1 migrations apply DB --remote`
4. `npx wrangler deploy --dry-run`
5. `npx wrangler deploy`

Apply the D1 migration before the Worker deploy. No GPT Instructions, Action schema, or Action authentication change is required for Phase 24-25 research activation.
