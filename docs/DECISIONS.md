# Decisions

## D-001 — Implement one Phase at a time

- Date: 2026-07-24
- Status: accepted
- Decision: Phase 0 contains no Binance or trading-rule implementation.
- Reason: packaging, native storage, and security boundaries must be validated
  before market logic is introduced.
- Revisit: never; this is the repository workflow.

## D-002 — Use Node 24 built-in SQLite for the initial DB driver

- Date: 2026-07-24
- Status: accepted with review condition
- Decision: use `node:sqlite` `DatabaseSync` behind `AppDatabase` instead of
  `better-sqlite3`.
- Reason: the initial `better-sqlite3` technical validation required a native
  rebuild and failed in the restricted build filesystem. Electron 43 embeds
  Node 24, which provides SQLite without a separate native ABI or packaging
  step. This follows the project specification's instruction to retain the DB
  interface and replace only the driver if compatibility is blocked.
- Tradeoff: Node 24 still reports `node:sqlite` as experimental.
- Revisit: after Windows packaging and persistence QA, or if a required SQLite
  capability is missing.

## D-003 — Expose explicit IPC methods only

- Date: 2026-07-24
- Status: accepted
- Decision: the preload exposes a typed `DesktopApi`; raw `ipcRenderer` and
  dynamic channel names are not exposed.
- Reason: limits the renderer's authority and makes all inputs auditable.
- Revisit: only when a new specification-approved IPC operation is required.

## D-004 — Restrict external URLs to ChatGPT

- Date: 2026-07-24
- Status: accepted
- Decision: only HTTPS URLs with the exact origin `https://chatgpt.com` may be
  opened.
- Reason: prevents arbitrary external navigation through renderer input.
- Revisit: when the user configures a dedicated GPT URL; the origin remains the
  same unless explicitly approved.

## D-005 — Closing the window keeps the tray process alive

- Date: 2026-07-24
- Status: accepted
- Decision: the normal close button hides the app. Full exit is available from
  the tray menu.
- Reason: later phases require continuous local monitoring while the window is
  not visible.
- Revisit: when a user setting for close behavior is added.

## D-006 — Package Windows only

- Date: 2026-07-27
- Status: accepted
- Decision: keep the Squirrel Windows maker and remove Debian, RPM, and macOS
  ZIP makers.
- Reason: the confirmed product environment is Windows 11. Unused platform
  makers add build dependencies and audit findings without providing user
  value.
- Revisit: only if another operating system enters the confirmed product scope.
