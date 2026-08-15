# Phase 14 — Trade Quality Telemetry

## Goal

Measure whether a GPT decision became a good trade after costs and execution friction, without adding a local directional signal or changing manual execution.

Phase 14 extends the existing Phase 13 lineage:

`decisionId → planId → tradeId → quality / outcome`

The first vertical slice runs in the Worker from the compact snapshot stream that the desktop app already uploads. The desktop trading path does not need an additional write loop.

## Metrics

For a linked validated `ENTER_NOW` decision the Worker records:

- `decisionToPlanLockMs`: GPT decision record → approved local plan lock latency.
- `triggerToTradeOpenMs`: approved trigger → observed PAPER/LIVE trade open latency when the open time is usable.
- `entryTimingQuality`: `EXACT | INFERRED | UNAVAILABLE`.
- `plannedEntry` and first observed `actualEntry`.
- `entryDriftBps`: signed adverse drift. Positive means the actual entry was worse than planned; negative means it was better.
- `initialRiskUsdt`: approved plan estimated maximum loss, with gross stop-distance risk as a fallback.
- `mfeBps` / `maeBps`: maximum favorable/adverse price excursion from the first observed actual entry.
- `mfeUsdt` / `maeUsdt`: those excursions converted with the trade's initial quantity.
- `mfeR` / `maeR`: excursion divided by `initialRiskUsdt`.
- `realizedNetR`: closed trade net PnL divided by `initialRiskUsdt`.
- `holdingTimeMs`.
- `costBasis`: whether cost fields are PAPER model values or partial LIVE observations.

## Sampling

MFE/MAE is updated from the normal compact snapshot upload stream. While a trade is open, the current `marketState.markPrice` is sampled. Once a trade is closed, the trade's stored `lastMarkPrice` is used so post-close price movement cannot inflate the excursion.

Existing maxima are retained across later snapshots.

This means Phase 14 measures the market path at relay sampling frequency; it does not claim tick-perfect exchange extrema.

## PAPER vs LIVE

### PAPER

- entry open time is treated as exact for the PAPER lifecycle.
- the existing PAPER fee/slippage/funding values are model-derived, so `costBasis = PAPER_MODELED`.
- PAPER execution drift is expected to be zero under the current simulator because PAPER enters at the approved plan entry.

### LIVE_MANUAL

- `OBSERVED_FROM_FLAT` live attribution gives `entryTimingQuality = EXACT`.
- `INFERRED_FROM_RECENT_TRADES` gives `INFERRED`.
- `OBSERVED_AFTER_CONNECT` gives `UNAVAILABLE`, and trigger-to-open latency is not fabricated.
- current live accounting can observe qualifying commission data but does not yet provide complete exchange funding/slippage attribution. Therefore the Worker records `LIVE_FEES_ONLY` or `LIVE_INCOMPLETE` rather than pretending the cost record is complete.

## R definition

`initialRiskUsdt` uses the approved plan's deterministic `estimatedMaxLoss` when available. If it is absent, the fallback is:

`abs(planned entry - planned stop) × initial quantity`

MFE/MAE in R use the same denominator. `realizedNetR` uses cost-adjusted realized net PnL over that denominator.

## Safety and interpretation

- Metrics are analytics-only.
- They never create, modify, or cancel a Binance order.
- They never generate LONG/SHORT locally.
- Missing or uncertain execution timestamps remain null/unavailable.
- LIVE missing funding/slippage remains missing rather than estimated as actual.
- MFE/MAE are relay-sampled, not advertised as tick-perfect extrema.

## Deployment

1. Pull the merged code.
2. Apply D1 migration `0006_trade_quality_telemetry.sql` remotely.
3. Deploy the Worker.
4. No Custom GPT Action schema or Instructions change is required for this Phase 14 slice.
