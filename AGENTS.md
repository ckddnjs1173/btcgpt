# Repository instructions

## Source of truth

1. Read `docs/PROJECT_SPEC.md` before implementation.
2. `docs/PROJECT_SPEC.md` is the only repository source of truth.
3. The project specification and explicit current user instruction take
   precedence over assumptions.

## Non-negotiable product boundaries

- Support only `BTCUSDT` USDⓈ-M perpetual futures.
- Allow user-selected leverage from 1 to 150, defaulting to 10, with isolated
  margin only.
- Validate the selected leverage and notional against Binance's current
  symbol limits and leverage brackets; block invalid plans without changing
  user-entered margin, quantity, or notional.
- Use maximum-loss limits to block plans and explain alternatives, never to
  silently resize user-entered values.
- Never implement order create, modify, cancel, withdrawal, or transfer
  requests.
- Never call the OpenAI API.
- Never invent a win rate or probability before validated statistics exist.
- Block entry decisions when required data is stale.
- Use only closed candles for new-entry triggers.
- Do not allow averaging down a losing position.

## Security

- Keep Electron Main, Preload, and Renderer responsibilities separated.
- Keep `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`.
- Expose named, typed IPC functions only. Never expose `ipcRenderer` directly.
- Validate every IPC input at runtime.
- Never log or return API secrets, signatures, full keys, account identifiers,
  DB contents, or private raw responses.
- Never commit `.env`, credentials, DBs, backups, logs, exports, or personal
  data.
- Do not add unapproved external origins to the allowlist.

## Architecture

- Keep shared types and schemas free of Electron and renderer dependencies.
- Keep calculation modules as pure TypeScript functions.
- Normalize external API responses in adapters before using them.
- Do not pass raw Binance responses to the renderer.
- Preserve DB interfaces when changing storage drivers.

## Work sequence

- Implement one Phase at a time.
- Do not implement later-Phase features speculatively.
- Run the validation commands explicitly requested by the current user before
  declaring work complete.
- Keep `main` runnable and tested.
