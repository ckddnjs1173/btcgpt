# Market Intelligence V2

> Status: user-approved implementation plan for the post-Phase-25 feedback loop
> Execution target: Binance BTCUSDT USDⓈ-M perpetual, manual execution only
> Contract target: objective multi-market evidence for GPT judgment

## 1. Product boundary

The live trading instrument remains BTCUSDT. Other assets and venues are observation sources only.

The program may collect, normalize, timestamp, aggregate and validate objective evidence. It must not create a local LONG/SHORT recommendation, directional setup score, entry recommendation, or automatic order action. GPT remains the market interpreter and trading decision-maker; the user remains the order executor.

## 2. Data-plane tiers

- `EXECUTION_CORE`: BTCUSDT. Existing BTC collection and entry/management gates remain authoritative.
- `LEAD_CORE`: initially ETHUSDT and SOLUSDT. High-frequency auxiliary evidence.
- `SENTIMENT_CORE`: initially BNBUSDT, XRPUSDT, DOGEUSDT, LINKUSDT and SUIUSDT. Medium-depth market-wide evidence.
- `DYNAMIC`: liquidity/representation-selected Binance USDT perpetuals. Selection must use non-directional market-representativeness inputs only.

Dynamic selection must not use recent return direction, RSI, CVD direction, delta direction, expected return, or any equivalent trading signal.

## 3. Evidence provenance

Every new market-intelligence source must preserve enough metadata to distinguish what the program actually observed from what it derived or estimated.

`metricNature`:

- `OBSERVED`
- `DERIVED`
- `ESTIMATED`
- `POINT_IN_TIME`
- `REVISED`

`coverage`:

- `EXHAUSTIVE`
- `SNAPSHOT`
- `SAMPLED`
- `UNKNOWN`

Timing fields:

- source event time when the source exposes it
- local collector receive time
- generated/normalized time
- age
- source-to-collector lag when measurable
- collector-to-generated processing lag

A liquidation snapshot must not be labeled exhaustive. Estimated liquidation levels must never share the same semantic field as observed liquidation events.

## 4. Freshness classes

- `CORE_BLOCKING`: only evidence explicitly required by the BTC live execution path may directly block entry.
- `AUX_DEGRADED`: important auxiliary evidence such as ETH/SOL. Staleness degrades the evidence but does not directly block BTC entry.
- `AUX_OPTIONAL`: dynamic basket, cross-venue and other optional enrichment. Failure removes or degrades that evidence only.

The existing BTC `DecisionGates` remain authoritative. Market Intelligence V2 must not silently replace their thresholds.

Initial auxiliary SLO defaults are configuration targets, not immutable market truths:

- ETH/SOL trade/book: normal through 3s, usable through 8s
- ETH/SOL current OI: normal through 20s, usable through 90s
- Dynamic basket price evidence: normal through 5s, usable through 15s
- Dynamic basket OI: normal through 60s, usable through 180s

These defaults are adjusted only from soak/replay evidence.

## 5. Bundle sequence

### Bundle 1 — Data-plane foundation

- shared objective evidence contracts
- provenance and timing
- auxiliary freshness policy
- monotonic multi-venue observation cache
- contract tests that prevent auxiliary data from becoming a direct entry gate
- no BTC runtime behavior change

### Bundle 2 — ETH/SOL Lead Core

Collect and aggregate ETHUSDT/SOLUSDT book ticker, shallow depth, aggregate trades, mark price, 1m candles, observed liquidation events, current OI and funding. Produce objective short-horizon returns, normalized trade flow, microstructure, OI changes and BTC-relative performance.

### Bundle 3 — Alt Market Intelligence

Add the fixed sentiment basket, dynamic representative basket, price/volume/delta/OI/funding/observed-liquidation breadth, relative strength, dispersion, BTC isolation and OI rotation.

### Bundle 4 — Decision Context

Expose a compact, strict-schema decision context for GPT. Preserve `getLatestSnapshot` for detail/debug use. Measure end-to-end market-to-GPT latency and avoid raw candle/order-book/trade payload expansion.

### Bundle 5 — Trigger and position precision

Structure GPT-authored WAIT triggers and add deterministic validation for partial exits, exits, stop moves and target changes. Trigger observation never becomes automatic order execution.

### Bundle 6 — Evaluation V2

Evaluate 1m/3m/5m/15m/30m/60m outcomes, plan-aware TP/SL path, MFE/MAE in R, WAIT trigger quality, NO_TRADE opportunity distribution and position-management decisions.

### Bundle 7 — External expansion

Only after replay evidence: Coinbase high-frequency spot context, Deribit options V2, then optional paid/third-party derivatives, liquidation and on-chain providers.

## 6. Promotion rule

New evidence axes are evaluated by ablation against a frozen baseline. No automatic model, prompt, context, sizing or leverage promotion is allowed. Research outcomes remain `REJECT`, `MORE_DATA`, or `LIVE_CANDIDATE`, followed by manual approval and live rollback capability.
