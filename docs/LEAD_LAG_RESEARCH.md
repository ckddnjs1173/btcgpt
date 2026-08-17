# Lead/Lag Replay Research

## Purpose

`research:lead-lag` tests whether objective auxiliary observations that were frozen at decision time are associated with later BTCUSDT mark-price returns.

The command is a research/evaluation tool. It does not create a live trading rule, local LONG/SHORT signal, entry recommendation, or automatic promotion decision.

## Inputs

The command uses the existing authenticated relay research endpoints:

- `GET /v1/research/cases?finalized=true`
- `GET /v1/replay/case/{decisionId}/input`
- `GET /v1/replay/case/{decisionId}/outcome`

The replay input is the exact frozen decision-time payload. Later relay mark-price observations are outcome labels. This keeps the research basis aligned with replay and avoids substituting current/revised auxiliary data for the evidence GPT actually saw.

## Features

The initial feature set is intentionally objective and narrow:

- ETHUSDT returns: 15s, 30s, 1m, 3m, 5m
- SOLUSDT returns: 15s, 30s, 1m, 3m, 5m
- ETH minus BTC returns: 1m, 3m, 5m
- SOL minus BTC returns: 1m, 3m, 5m
- Dynamic-alt median returns: 1m, 3m, 5m
- Dynamic-alt median minus BTC: 1m, 3m, 5m
- Dynamic-alt normalized-delta median: 1m
- Dynamic-alt open-interest-change median: 1m

Future BTC targets are 1m, 3m, 5m, and 15m return bps from the replay outcome path.

## Statistics

For each feature/target pair the report includes:

- sample count and `SPARSE` / `RESEARCH_READY` status
- Pearson correlation
- Spearman rank correlation
- sign-agreement rate
- future-return distribution when the feature is positive versus negative
- top- versus bottom-quartile future-return separation

These are association statistics only. They do not establish that ETH, SOL, breadth, delta, or OI caused the later BTC move.

## Usage

```powershell
$env:RELAY_URL='https://your-worker.example.workers.dev'
$env:ACTION_READ_KEY='...'
npm run research:lead-lag -- --limit=500 --min-samples=20
```

Optional output prefix:

```powershell
npm run research:lead-lag -- --out=research/lead-lag-2026-08-17
```

The command writes `<prefix>.json` and `<prefix>.md`.

## Interpretation boundary

A high historical correlation or large quartile separation is not enough to alter the live GPT policy. Candidate evidence must still pass replay/evaluation review across sufficient samples, regimes, latency/completeness cohorts, and out-of-sample periods. Promotion remains a manual evidence review; the program does not convert this report into a market direction or entry signal.

## Optional external providers

`ExternalProviderRegistry` is the runtime isolation layer for optional future providers such as derivatives aggregates, estimated-liquidation models, extended on-chain sources, or ETF sources. A failed optional provider is tracked independently and does not block the free core or BTC entry gates.

Provider-specific credentials, subscriptions, and commercial API calls are not bundled or guessed. Estimated-liquidation implementations must continue to use `ESTIMATED` semantics and must never be presented as observed Binance liquidation totals.
