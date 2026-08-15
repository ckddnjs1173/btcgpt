# Phase 15 — Objective Market Fingerprint

## Goal

Create a stable, objective representation of the market state that GPT actually analyzed so later phases can compare similar historical situations, replay decisions, and evaluate whether added context improves outcomes.

The fingerprint is not a strategy score, regime label, LONG/SHORT signal, or probability estimate.

## Storage flow

Phase 15 uses two D1 tables:

1. `snapshot_fingerprint_cache`
   - stores only a rolling 30-minute cache of compact snapshot fingerprints.
   - exists so a GPT decision can still bind to the exact snapshot it analyzed after `latest_snapshot` has already advanced.
   - stale cache rows are deleted automatically.
2. `decision_market_fingerprint`
   - stores the exact fingerprint for a recorded GPT decision.
   - is keyed by `decisionId` and persists after the short snapshot cache expires.

This avoids permanently storing every relay snapshot while preserving the market state for decisions that matter.

## Fingerprint v1

Version: `mf-v1`

The payload contains:

- `snapshotId`
- `marketGeneratedAt`
- `anchorMarkPrice`
- a flat numeric `features` map
- `missingFeatures`
- total/present feature counts
- completeness ratio

`anchorMarkPrice` is retained for reconstruction and reporting, but raw BTC price level is not used as a similarity feature.

### Market and derivatives state

- spread bps
- basis percent
- funding rate in bps
- 24h price change
- mark/index divergence in bps
- microprice distance from mark in bps

### Multi-timeframe structure

For `1m`, `5m`, `15m`, `1h`, and `4h`:

- 1/3/12-bar percentage returns
- ATR percent
- realized volatility percent
- RSI14
- mark distance from EMA20/50/200 in bps

### Scalp structure

For `1m` and `5m`:

- candle body/wick ratios
- close location
- EMA20 slope normalized to bps per candle
- VWAP distance bps
- pivot distances in ATR units
- 5-vs-20 range compression
- volume z-score

### Order flow and depth

For selected `15s`, `1m`, and `5m` flow windows:

- signed buy pressure derived from taker buy ratio
- price change bps
- trades per second
- impact bps per BTC

Depth features include:

- level 20/50/100 imbalance
- 5s/30s imbalance change
- 5s bid dominance ratio
- normalized bid/ask wall skew

### Positioning, sentiment, and liquidations

- local OI change 1m/5m
- official OI change 5m/15m/1h/4h
- global/top-account/top-position long-short ratios centered around neutral 1.0
- taker buy/sell ratio centered around neutral 1.0
- liquidation skew for 1m/5m/15m
- liquidation intensity normalized by OI notional

### Objective event/session context

- high-risk-news flag
- Binance critical notice flag
- on-chain anomaly flag
- minutes until the next known macro event
- Fear & Greed value when available
- cyclic UTC hour and weekday coordinates

## Similarity design rules

- Prefer scale-resistant features such as percentages, bps, ratios, ATR units, and normalized skew.
- Preserve missing values as `null`; never fill them with invented defaults.
- Do not derive bullish/bearish labels or a local trading score.
- Do not use GPT interpretation in the fingerprint.
- Fingerprint version changes must be explicit. Future cross-market/options/news features can create a later version instead of silently changing `mf-v1` semantics.

## Snapshot replacement handling

The desktop relay may upload a newer snapshot while GPT is still reasoning. Phase 13 correctly records such a decision as `SUPERSEDED` rather than discarding it.

Phase 15 therefore caches fingerprints for 30 minutes. When `recordDecision` arrives, the Worker looks up the exact `snapshotId + marketGeneratedAt` and copies that fingerprint into `decision_market_fingerprint`.

If the current snapshot still matches, the Worker can derive the fingerprint directly from `latest_snapshot` as a fallback. If neither source is available, the Worker does not invent a fingerprint and the decision record remains valid without one.

## Safety

- analytics only
- no Binance order create/modify/cancel capability
- no local LONG/SHORT signal
- no probability or win-rate fabrication
- no chain-of-thought storage
- fingerprint failure never blocks the live snapshot relay or decision record

## Deployment

1. Pull the merged code.
2. Apply D1 migration `0007_market_fingerprint.sql` remotely.
3. Deploy the Worker.
4. No Custom GPT Action schema or Instructions change is required for this Phase 15 slice.
