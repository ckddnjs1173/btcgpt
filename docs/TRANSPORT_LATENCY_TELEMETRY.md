# Transport Latency Telemetry

This document defines objective timing telemetry for the live BTC decision path. Timing fields are diagnostics and research evidence only. They never create a LONG/SHORT signal, change an entry gate by themselves, or authorize an exchange write.

## Clock boundaries

The live path is observed at these points:

1. `marketGeneratedAt` — local market snapshot generation time.
2. `relayUploadStartedAt` — desktop begins the relay PUT.
3. `relayReceivedAt` — Worker accepts the snapshot and writes it to D1.
4. `decisionContextActionStartedAt` — Worker begins building `getDecisionSnapshot`.
5. `decisionContextGeneratedAt` — Worker finishes the compact Decision Context.
6. `decisionRecordedAt` — Worker persists the GPT decision.
7. `planLockedAt` — user-approved plan is locked locally.
8. `triggeredAt` — GPT-authored WAIT trigger becomes mechanically satisfied, when applicable.
9. `tradeOpenedAt` — paper or read-only observed live fill opens the trade.
10. `tradeClosedAt` — observed trade close.

## Derived segments

- `marketToRelayReceiveMs = relayReceivedAt - marketGeneratedAt`
- `relayRoundTripMs = desktop response receive - relayUploadStartedAt`
- `relayToActionStartMs = decisionContextActionStartedAt - relayReceivedAt`
- `contextBuildMs = decisionContextGeneratedAt - decisionContextActionStartedAt`
- `contextToDecisionRecordMs = decisionRecordedAt - decisionContextGeneratedAt`
- `marketToDecisionRecordMs = decisionRecordedAt - marketGeneratedAt`
- `decisionToPlanLockMs = planLockedAt - decisionRecordedAt`
- `triggerToTradeOpenMs = tradeOpenedAt - triggeredAt`, when trigger timing is exact or inferable.

Existing telemetry remains the source of truth where already available. This work adds missing transport fields instead of duplicating them under incompatible names.

## Interpretation

Latency is a quality dimension, not a trading signal. High latency can explain missed fills, chase, stale evidence, or execution drift. Promotion research may cohort results by latency, but no threshold should be promoted to a live rule without replay/live evidence.

## Missing data

Unavailable timestamps must remain `null`. Do not manufacture zero latency. Live manual execution may only expose the exchange-observed fill timestamp; the exact moment the user clicked Binance is not observable unless the user explicitly records it in a future workflow.
