# Frozen Decision Context Audit

## Purpose

Before paying to run Replay/Eval or interpreting an evidence-ablation result, verify that the selected frozen cases actually contain the intended decision-time evidence with observable freshness metadata.

This audit is descriptive only. It does not create a LONG/SHORT signal, score a trading strategy, select an ablation winner, or promote a context source.

## Input

Use an existing replay experiment or campaign-selection JSON that contains either:

- `decisionIds`
- `selectedDecisionIds`

The audit fetches only the existing authenticated read-only replay endpoint:

`GET /v1/replay/case/{decisionId}/input`

Only `decision-context-v1` snapshots are considered valid Decision Context cases. Legacy market-snapshot cases remain visible as invalid input basis rather than being silently treated as equivalent.

## Command

```powershell
$env:RELAY_URL='https://your-worker.workers.dev'
$env:ACTION_READ_KEY='...'
npm run research:context-audit -- research/base-campaign.experiment.json research/context-audit
```

Outputs:

- `research/context-audit.json`
- `research/context-audit.md`

The command makes no OpenAI API call and does not modify production.

## Audited dimensions

### Contract basis

- case count
- valid `decision-context-v1` count and rate
- invalid/legacy input basis
- snapshot ID and market/context timestamps

### Payload and transport timing

Per case and aggregate distribution:

- serialized frozen replay payload bytes
- `marketAgeMs`
- `cryptoMarketAgeMs`
- `marketToRelayMs`
- `relayToActionStartMs`
- `contextBuildMs`

The report shows min/mean/p50/p95/max where available. It does not invent a payload-size or latency pass/fail threshold.

### Evidence-axis presence

The audit records whether each frozen case actually contains:

- `LEAD_CORE`: both ETHUSDT and SOLUSDT lead-core evidence
- `ALT_BREADTH`: alt-market context
- `COINBASE`: cross-venue context
- `OPTIONS_V2`: Deribit options V2 context
- `ONCHAIN_V1`: structured on-chain context

Presence is not treated as evidence of usefulness. Matched evidence ablation remains the mechanism for testing decision value.

### Freshness and source health

For auxiliary market evidence, the audit preserves decision-time `EvidenceHealth` observations and aggregates:

- `NORMAL`
- `DEGRADED`
- `STALE`
- `UNAVAILABLE`
- unknown status

It also reports source-level observation counts, non-normal rate and age distribution. Options/on-chain provenance and reported collection-age fields are retained in the JSON case detail where available.

### Completeness-contract consistency

The audit compares the frozen payload against its own completeness metadata for:

- crypto-market availability
- lead-asset count
- dynamic alt-asset count

A mismatch is reported explicitly and never repaired by inference.

## Interpretation order

Use the tools in this order:

1. frozen context audit — verify what evidence was actually present and how fresh it was;
2. matched evidence ablation — compare the same frozen cases with evidence axes removed/restored;
3. Evaluation V2 / research benchmark — compare decision outcome vectors;
4. manual review — `REJECT | MORE_DATA | LIVE_CANDIDATE` only after sufficient samples and regime coverage.

A source with poor availability may fail before decision-value testing. A source with excellent availability may still add no trading value. These are separate questions and should stay separate.

## Safety boundaries

- no Binance order create/modify/cancel;
- no local LONG/SHORT engine;
- no current-web reconstruction of missing historical evidence;
- no future-outcome use in the context audit;
- no scalar winner score;
- no automatic live promotion;
- no paid OpenAI API execution.
