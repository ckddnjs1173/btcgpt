# Repository instructions

## Source of truth

1. Read `docs/PROJECT_SPEC.md` before implementation.
2. For Phase 13 and later, also read `docs/PROJECT_SPEC_PHASE13_PLUS.md`.
3. `docs/PROJECT_SPEC_PHASE13_PLUS.md` is the user-approved Phase 13+ extension and overrides only the legacy scope statements in `docs/PROJECT_SPEC.md` that conflict with it.
4. For Market Intelligence V2 work, also read `docs/MARKET_INTELLIGENCE_V2.md`.
5. The project specifications and explicit current user instruction take precedence over assumptions.

## Non-negotiable product boundaries

- The current manually executed trading instrument remains Binance `BTCUSDT` USDⓈ-M perpetual futures unless a later approved phase explicitly changes the execution target.
- Allow user-selected leverage from 1 to 150, defaulting to 10, with isolated margin only.
- Validate the selected leverage and notional against Binance's current symbol limits and leverage brackets; block invalid plans without changing user-entered margin, quantity, or notional.
- Use maximum-loss limits to block plans and explain alternatives, never to silently resize user-entered values.
- Never implement Binance order create, modify, cancel, withdrawal, or transfer requests.
- The live desktop app must not call the OpenAI API unless a later approved phase explicitly implements a separated research/eval path.
- Never invent a win rate or probability before validated statistics exist.
- Split market analysis, new-entry, and position-management data gates. Stale entry-only data must not automatically suppress management of an existing position when mark, position, and protective-order data remain usable.
- Use only closed candles for new-entry confirmation; live 1m/5m candles may be timing evidence but never masquerade as confirmed closes.
- Track only user-approved executable plans. Never generate a local LONG/SHORT signal.
- Local alerts may report approved trigger, invalidation, data-quality, and protective-coverage changes, but must never place an order.
- Responses intended for Binance entry must put the validated input values before explanatory analysis.
- Do not allow averaging down a losing position.
- Phase 13+ may collect other exchanges, other assets, news, macro, options, on-chain, or other objective context when the purpose is to improve GPT judgment rather than to create a local trading signal.

## Security

- Keep Electron Main, Preload, and Renderer responsibilities separated.
- Keep `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`.
- Expose named, typed IPC functions only. Never expose `ipcRenderer` directly.
- Validate every IPC input at runtime.
- Never log or return API secrets, signatures, full keys, account identifiers, DB contents, or private raw responses.
- Never commit `.env`, credentials, DBs, backups, logs, exports, or personal data.
- Do not add unapproved external origins to the allowlist.

## Architecture

- Keep shared types and schemas free of Electron and renderer dependencies.
- Keep calculation modules as pure TypeScript functions.
- Normalize external API responses in adapters before using them.
- Do not pass raw Binance responses to the renderer.
- Preserve DB interfaces when changing storage drivers.
- Keep live trading latency-sensitive paths separate from research/eval and slow external-context work.

## Work sequence

- For legacy numbered work, implement one approved Phase at a time. After the Phase 24–25 foundation, prefer named workstreams/contracts instead of inventing additional Phase numbers.
- Within an approved Phase or workstream, prefer the smallest complete vertical slice over speculative scaffolding.
- Do not implement unapproved future execution behavior or paid-provider dependencies speculatively; optional provider interfaces are allowed when they preserve a dependency-free core.
- Run the validation commands explicitly requested by the current user before declaring work complete.
- Keep `main` runnable and tested.
