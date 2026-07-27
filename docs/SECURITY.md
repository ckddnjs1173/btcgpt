# Security

## Product boundary

This application is a read-only monitoring and calculation assistant. It must
never create, modify, or cancel exchange orders. A user-entered protective stop
on the exchange remains the final safety mechanism.

## Electron boundary

- Main owns the OS, DB, network, secrets, and future Binance clients.
- Preload exposes named methods through `contextBridge`.
- Renderer displays view models and sends validated user input.
- Renderer has no Node.js, filesystem, DB, shell, or secret access.

Required BrowserWindow settings:

```ts
{
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true
}
```

Popup windows and renderer navigation are blocked. External pages are opened
only through Main after exact-origin allowlist validation.

## IPC

- Every channel is a constant defined in `src/shared/contracts.ts`.
- Every value from Renderer is treated as untrusted.
- Zod validates string length, object shape, URL protocol, and URL origin.
- The preload never exposes raw `ipcRenderer`.
- Main responses must not contain secrets or unnecessary local paths.

## Credentials

Phase 0 has no credentials. In Phase 4:

- Accept read-only Binance keys only.
- Never request order, withdrawal, or transfer permissions.
- Encrypt the Secret with Electron `safeStorage` in Main.
- Store only ciphertext.
- Never return the Secret to Renderer after saving.
- Mask keys, secrets, signatures, and `X-MBX-APIKEY` in logs.
- Never include account identifiers or credentials in GPT handoffs.

## Logging

Pino redacts these names at minimum:

- `apiKey`
- `secret`
- `signature`
- `X-MBX-APIKEY`

Do not log signed query strings, raw account responses, DB records, or user
clipboard contents.

## Repository exclusions

Never commit:

- `.env` files other than `.env.example`
- API keys, secrets, ciphertext, or credentials
- DB, WAL, and SHM files
- logs, backups, and exports
- account or candidate data
- built installers

If a real key is committed, revoke it immediately. Removing the text from a
later commit does not make the exposed key safe.

## Data-failure behavior

Future market-data code must fail closed:

- stale core data blocks new-entry signals
- account failure falls back to public mode
- unknown protective-order state creates a warning
- no missing value may be silently guessed
