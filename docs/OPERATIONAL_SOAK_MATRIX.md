# Operational Soak Matrix

## Purpose

This workstream validates that the live data plane remains usable across long runtimes and expected Windows/network lifecycle events. It is operational evidence only. It does not create market direction, entry signals, order actions, or automatic strategy promotion.

## Automated checks

### Repository validation

Run before any live soak:

```powershell
npm ci
npm run check
npm run format:check
npm run build
```

### Public Binance smoke

```powershell
npm run test:binance-smoke
```

This confirms the currently documented public REST/WebSocket paths are reachable and parseable. It is not a long-duration reliability result.

### Packaged-app relay soak

With the packaged app already running and connected to the production relay:

```powershell
$env:RELAY_PRODUCTION_URL='https://your-worker.workers.dev'
$env:RELAY_APP_PID='<packaged-app-pid>'
$env:RELAY_SECRET_FILE='secrets/cloudflare-production.json'
npm run test:relay-app-soak
```

The existing relay soak checks process liveness, fresh snapshot turnover, required BTC timeframe completeness, and usable analysis-gate coverage.

### Decision Context soak

```powershell
$env:RELAY_PRODUCTION_URL='https://your-worker.workers.dev'
$env:RELAY_APP_PID='<packaged-app-pid>'
$env:RELAY_SECRET_FILE='secrets/cloudflare-production.json'
npm run test:decision-context-soak
```

The Decision Context soak samples `/v1/decision-context/latest` and records:

- request success ratio
- market-data freshness ratio
- snapshot turnover
- p95/p99 market age
- p95 Action round-trip latency
- p95 market-to-relay latency when available
- p95/max serialized Decision Context bytes
- how often the BTC entry gate is actually open

The engineering payload target is 50 KB by default. Exceeding it is reported as a diagnostic warning rather than a hard failure because the target is an optimization budget, not a correctness boundary. Override with `DECISION_CONTEXT_TARGET_MAX_BYTES` only for measurement, not to hide regressions.

## Duration ladder

Promote sequentially. A later soak does not erase an earlier failure mode.

1. 30 minutes — basic runtime stability after a clean start.
2. 2 hours — reconnect/backoff, REST refresh, external-source polling, relay cadence.
3. 6 hours — memory/CPU trend observation and repeated auxiliary refresh cycles.
4. 24 hours — required long-run gate, including Binance's connection-lifetime boundary. BTC and lead-core connections deliberately reconnect at 23 hours.
5. Sleep/resume — Windows suspend and resume with the app running.
6. Network disconnect/reconnect — disable networking long enough to force socket failures, then restore it.
7. High-volume session — repeat during materially elevated BTC volume when message rates and order-book churn are higher.

## Acceptance criteria

### BTC core

- packaged app remains running
- no unbounded growth in telemetry buffers
- public and market WebSockets reconnect after failure
- planned reconnect happens before the 24-hour Binance connection lifetime
- local order book becomes synchronized again after reconnect or update-ID gap
- critical BTC freshness failures can block new entry, but do not invent a trading direction

### Auxiliary evidence

- ETH/SOL, alt basket, Coinbase, Deribit, on-chain, and optional providers may degrade independently
- auxiliary degradation alone must not become a BTC entry blocker
- missing auxiliary values remain missing/null rather than manufactured zeros
- observed, derived, estimated, and revision-capable evidence retain their distinct provenance semantics

### Relay / Decision Context

- snapshot IDs continue to change over time
- successful Decision Context samples >= 99%
- fresh samples among successful reads >= 95% using the configured market-age threshold
- Decision Context remains `decision-context-v1`
- `btcCore.decisionGates` remains present
- payload size and latency distributions are captured for review

## Manual lifecycle observations

For sleep/resume and network-loss tests, record the exact start/end timestamps and inspect the application logs around the event. The expected behavior is restart/reconnect and objective health degradation/recovery. A trigger notification is never permission to enter a trade; fresh GPT reanalysis remains required.

## Promotion rule

Operational soak results can qualify a build as more reliable, but they do not prove profitability and do not promote any evidence source into a live decision rule. Research/evaluation promotion remains separate and manual.
