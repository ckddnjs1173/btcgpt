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

## Interpretation

Compare adjacent profiles first, not only `BASELINE` versus `ONCHAIN_V1`. A useful result should survive sufficient samples, multiple market regimes, latency/completeness cohorts, and an out-of-sample period.

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
- Keep experiment IDs, model/instruction/context versions, case IDs, and result lineage auditable.
