# Approved Plan Monitoring

> `docs/PROJECT_SPEC.md` remains the only product source of truth. This file is an operational note for the Phase 12 implementation.

A locked plan is monitored only after the user explicitly approves it in the desktop app. The monitor never generates LONG/SHORT direction and never sends, modifies, or cancels a Binance order.

- `WATCHING`: the approved plan is waiting for its stored Mark-price trigger.
- `TRIGGERED` / lifecycle `ENTRY_READY`: the objective trigger was observed while the entry gate was allowed. This is not an executed order; the user must still review the latest market state and enter the Binance order manually.
- `INVALIDATED`: the stored invalidation price was reached before an actual matching position was observed. The local plan is cancelled.
- `EXPIRED`: the approved plan reached its local expiry time. The local plan is cancelled and must not be reused without a fresh analysis.
- `MANAGING`: an actual Binance read-only position or PAPER position is present. A live plan is bound only when side, leverage, and quantity match the approved plan.
- `CLOSED`: the bound position returned to flat and the tracked trade session was closed.

Local notifications are advisory. They do not replace Binance TP/SL protection and do not prove that an exchange order was filled.
