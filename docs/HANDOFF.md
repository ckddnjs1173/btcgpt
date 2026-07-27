# Handoff

> Updated: 2026-07-24  
> Completed scope: Phase 0 implementation

## What changed

- Created the Electron Forge, Vite, React, and TypeScript foundation.
- Added a secure Main / Preload / Renderer boundary.
- Added restricted IPC handlers for notification, clipboard, external URL, and
  SQLite checks.
- Added a local SQLite schema and persistence check.
- Added system tray behavior and close-to-tray lifecycle.
- Added a Korean Phase 0 dashboard.
- Added lint, typecheck, test, formatting, SQLite smoke, and package scripts.
- Added project, state, handoff, decision, and security documentation.

## Important files

- `src/main/index.ts`: Electron lifecycle
- `src/main/app/create-window.ts`: secure BrowserWindow
- `src/main/app/tray.ts`: tray lifecycle
- `src/main/ipc/register-handlers.ts`: allowed IPC operations
- `src/main/db/database.ts`: local SQLite wrapper and schema
- `src/preload/index.ts`: typed bridge
- `src/shared/contracts.ts`: IPC contract
- `src/shared/schemas.ts`: runtime validation
- `src/renderer/App.tsx`: Phase 0 dashboard
- `forge.config.ts`: packaging and fuses

## Reproduce

```powershell
npm ci
npm run check
npm start
```

Then test every button and restart the app to verify the DB timestamp remains.

```powershell
npm run build
npm run make
```

## Known issues and limitations

- Windows application packaging passed. Squirrel installer creation reached the
  distributable step and failed because package author metadata was empty; the
  required author value is now set and `npm run make` needs one rerun.
- Desktop notification and tray behavior still need direct Windows 11 manual
  confirmation.
- Phase 0 contains no Binance API or market data.
- `node:sqlite` is still shown as experimental by Node 24.
- The app has no production icon or code signature.

## Next work

Do not begin Phase 2. The next task is Phase 1 only:

1. Add Binance public REST schemas and adapters.
2. Add the `/market` and `/public` WebSocket connections specified in the
   project specification.
3. Initialize 250 closed candles for 5m, 15m, 1h, and 4h.
4. Add mark price, funding, OI, taker flow, and partial depth.
5. Add data freshness, reconnection, server time offset, and gap recovery.
6. Replace the Phase 0 runtime cards with a basic real-data dashboard while
   retaining the diagnostics.
7. Add fixtures and integration tests.

Before Phase 1, finish the Windows manual checklist and commit a clean Phase 0
baseline.
