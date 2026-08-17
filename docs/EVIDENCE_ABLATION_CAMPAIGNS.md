# Evidence Ablation Campaigns

## Purpose

This research workstream measures whether each approved auxiliary evidence axis adds decision value when everything else is held constant. It does not create a live trading rule and it does not automatically promote a source, prompt, model, sizing policy, or leverage setting.

The campaign order is cumulative:

1. `BASELINE` — BTC decision context plus unrelated context that is held constant; tested Market Intelligence V2 axes removed.
2. `LEAD_CORE` — add ETHUSDT/SOLUSDT lead-core evidence.
3. `ALT_BREADTH` — add fixed/dynamic alt-market breadth and relative evidence.
4. `COINBASE` — add Coinbase spot/perp cross-venue evidence.
5. `OPTIONS_V2` — add Deribit Options V2.
6. `ONCHAIN_V1` — add structured on-chain background/regime evidence.

The same frozen decision IDs and the same instructions are used for every profile. Only the listed Decision Context fields are removed or restored. Future outcomes are never used to choose cases or build the ablated input.

## Required replay basis

Ablation requires replay cases with `inputBasis=DECISION_CONTEXT`. Legacy `MARKET_SNAPSHOT` cases are rejected for ablation rather than silently treated as equivalent because they did not freeze all auxiliary evidence axes.

`crossMarket`, Trading Memory, reasoning policy, position-management state, and unrelated external context remain constant across profiles. This campaign is specifically intended to isolate the newer Market Intelligence V2 evidence axes, not to re-baseline every historical context source at once.

## Preparation

First create one matched base campaign using the existing finalized-case selector:

```powershell
$env:RELAY_URL='https://your-worker.workers.dev'
$env:ACTION_READ_KEY='...'
npm run replay:campaign:prepare -- campaign-spec.json research/base-campaign
```

Then generate all six matched ablation configs:

```powershell
npm run research:ablation:prepare -- research/base-campaign.experiment.json research/ablation
```

The command writes six experiment configs plus `campaign-manifest.json`. Every config contains the same `decisionIds` and instructions but a different `registry.evidenceProfile`.

## Batch preparation

Prepare each candidate separately:

```powershell
npm run replay:batch:prepare -- research/ablation/00-baseline.experiment.json research/ablation/00-baseline
npm run replay:batch:prepare -- research/ablation/01-lead-core.experiment.json research/ablation/01-lead-core
```

Continue for the remaining profiles only when desired. Batch preparation itself makes no paid API call. It fetches each frozen replay input and deterministically removes fields according to the selected evidence profile.

The generated batch manifest records `evidenceProfile`, `ablationBasis`, and `ablationApplied` for every item so a later result cannot be mistaken for an unmodified replay run.

## Paid execution boundary

Actual OpenAI Batch/Responses execution remains a paid research/evaluation action and requires explicit user approval. Preparing campaign files, frozen inputs, manifests, and comparison plans does not grant that approval.

## Result reporting

After the six experiment outputs have been ingested and scored, generate one matched comparison report from the campaign manifest:

```powershell
$env:RELAY_URL='https://your-worker.workers.dev'
$env:ACTION_READ_KEY='...'
npm run research:ablation:report -- research/ablation/campaign-manifest.json research/ablation/result
```

This command only calls authenticated read-only research endpoints. It writes:

- `research/ablation/result.json`
- `research/ablation/result.md`

The report verifies that every profile has the expected frozen-case count before marking adjacent comparisons as valid. It then shows each profile and each cumulative evidence step separately for:

- directional sample count and directional accuracy;
- average 30-minute signed return;
- WAIT/NO_TRADE sample count and remaining 30-minute opportunity;
- average model latency;
- reported API cost and cost per matched case;
- Eval V2 ENTER MFE R / MAE R and initial adverse excursion;
- TP1-before-stop versus stop-before-TP1 ordering where sampled paths resolve the order;
- WAIT_TRIGGER trigger, invalidation, expiry and max-chase rates;
- WAIT_TRIGGER post-trigger 15-minute favorable/adverse movement;
- position-management 30-minute favorable/adverse path vectors in the JSON report.

Path quality is read from:

`GET /v1/research/path-quality/{experimentId}`

The endpoint is read-only and aggregates existing `eval-v2` `score_payload` records. It does not add a D1 schema, create a trading signal, or recompute a future path from current market data.

Adjacent deltas are reported in this order:

- `BASELINE → LEAD_CORE`
- `LEAD_CORE → ALT_BREADTH`
- `ALT_BREADTH → COINBASE`
- `COINBASE → OPTIONS_V2`
- `OPTIONS_V2 → ONCHAIN_V1`

The report does not create a scalar winner score. A positive signed-return delta is not sufficient by itself to promote an evidence source, and a lower abstain-opportunity value is not interpreted independently from how often the profile chose ENTER versus WAIT/NO_TRADE. Latency, cost, sample sufficiency, market-regime coverage and out-of-sample behavior remain separate review dimensions.

Path-quality deltas require an additional caution: each profile may choose a different number of ENTER, WAIT_TRIGGER and position-management decisions. Therefore MFE/MAE, TP/SL ordering and trigger-quality deltas are conditional on the decisions that each profile actually made. They are descriptive evidence vectors, not isolated causal source effects.

No paid OpenAI API call is made by the reporting command.

## Interpretation

Compare adjacent profiles first, not only `BASELINE` versus `ONCHAIN_V1`. A useful result should survive sufficient samples, multiple market regimes, latency/completeness cohorts, and an out-of-sample period.

Review at least these vectors separately:

- decision mix and directional result;
- ENTER path quality;
- WAIT_TRIGGER path quality;
- missed opportunity;
- latency and cost;
- actual decision-linked Net R when available.

Promotion review outcomes remain:

- `REJECT`
- `MORE_DATA`
- `LIVE_CANDIDATE`

`LIVE_CANDIDATE` means the evidence is worth a controlled live evaluation; it is not automatic production promotion. The user remains the final approver.

## Integrity rules

- Never reconstruct removed evidence from current web data, model memory, or future outcomes.
- Never use later-revised on-chain values in place of the frozen decision-time payload.
- Never turn the ablation profile into a local LONG/SHORT or entry rule.
- Never infer causality from correlation or a single successful campaign.
- Never collapse ENTER, WAIT_TRIGGER and position-management path vectors into one strategy score.
- Keep experiment IDs, model/instruction/context versions, case IDs, and result lineage auditable.
