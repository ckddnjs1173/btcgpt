# Intelligence Batch — Phase 16C through Phase 20 foundation

## Why this is one batch

This batch intentionally groups several roadmap slices so deployment does not require repeated pull/migration/deploy cycles.

It includes:

- Phase 16C replay runner foundation
- Phase 17 objective cross-market intelligence
- Phase 18/19 integration of the external news/macro/options/on-chain sources already collected by the desktop service
- Phase 20 Context Router v1

It does not enable paid model calls automatically and does not add any Binance order-write capability.

## Live decision path

`getLatestSnapshot` is enriched at the Worker boundary:

`BTC compact snapshot -> objective cross-market fetch/cache -> routed external context -> intelligenceContext(context-v1) -> GPT`

The underlying BTC snapshot remains authoritative for freshness and entry gates. Optional cross-market or external-source failure does not silently replace or override BTC decision gates.

## Cross-market v1

Public, unauthenticated observations are collected for BTC, ETH and SOL from:

- Binance USD-M futures 24h ticker statistics
- Coinbase Exchange spot 24h product statistics

The context records only objective values:

- last price
- 24h return percent
- base/quote volume when available
- Binance/Coinbase cross-venue spread in bps
- ETH-vs-BTC and SOL-vs-BTC 24h relative-performance differences
- source availability and completeness

There is no local LONG/SHORT score or bullish/bearish label.

Fresh cross-market observations are cached in D1 for 20 seconds. A cached observation may be used for up to two minutes only when live public-source collection fails, and the source status explicitly becomes `CACHED`.

## Context Router v1

`context-v1` compresses the decision context into four sections:

1. BTC decision core: gates, market state, selected order flow, OI, sentiment, liquidations, indicators, scalp context, position and costs.
2. Cross-market context: Binance/Coinbase BTC/ETH/SOL objective values.
3. External context: up to 12 intraday items selected by BTC relevance, trust tier and recency.
4. Routing metadata: included source set, completeness and an explicit list of intentionally omitted high-volume fields.

The router deliberately omits:

- full candle arrays
- full order-book levels
- duplicate articles
- local directional labels
- replay future outcomes

The existing external collector already includes sources such as Deribit, GDELT, Fed/SEC/CFTC/BLS feeds, mempool.space, Coin Metrics Community and Fear & Greed. This batch routes those existing observations instead of creating duplicate collectors.

## Decision/replay binding

The enriched Action response is written back into the short-lived replay lease after the earlier Phase 16 lease step. Therefore, when `recordDecision` promotes a lease into an immutable replay case, the replay case contains the exact routed `intelligenceContext` that GPT received.

After a successful decision record, `decision_context_pack` stores the same context pack keyed by `decisionId`, including SHA-256 for reproducibility.

## Replay runner

`scripts/replay-runner.mjs` drives the Phase 16B registry endpoints.

Default/manual mode registers experiment metadata without making a paid model call.

OpenAI execution support exists behind two explicit local requirements:

- `OPENAI_API_KEY` must be present in the local shell environment.
- `ALLOW_PAID_REPLAY=YES` must also be set.

Without both, the script refuses to call the OpenAI API. No OpenAI secret is stored in the repository or Worker.

For an OpenAI run, the runner:

1. registers the experiment;
2. reads immutable replay input;
3. starts a run only after the 60-minute outcome is finalized;
4. calls the Responses API with strict structured output and no web/tools;
5. freezes the model output;
6. submits it for deterministic `eval-v1` scoring;
7. prints the experiment summary.

The prompt SHA-256 prefix is embedded into `instructionVersion` so a changed prompt produces a different experiment configuration hash.

## Database changes

`0010_context_intelligence.sql` adds:

- `cross_market_latest`
- `decision_context_pack`

If Phase 16B migration `0009_replay_experiment_registry.sql` has not yet been deployed, Wrangler will apply `0009` and `0010` in order during the same migration run.

## GPT update

The live Action schema does not need a new endpoint. `MarketSnapshot` already permits additional response properties, so the Worker can return `intelligenceContext` without adding another Action.

Append `worker/openapi/GPT_INSTRUCTIONS_INTELLIGENCE_BATCH_APPEND.md` after prior GPT instructions so telemetry versions advance to:

- `instructionVersion = phase20-v1`
- `contextPackVersion = context-v1` when available

## Deployment target

After the batch is merged:

1. `git pull origin main`
2. list/apply all pending D1 migrations once
3. deploy the Worker once
4. append the single GPT instruction file once

No desktop restart is required for the Worker-side intelligence/router/replay changes.
