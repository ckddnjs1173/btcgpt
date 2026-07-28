# Deployment and External Validation

## Cloudflare Worker and D1

Production Worker:
`https://btc-futures-assistant-relay.btcgpt-ck1173.workers.dev`

Prerequisites for maintenance: a Cloudflare account and Wrangler authenticated
in the target account.

```powershell
npm exec wrangler -- login
npm exec wrangler -- whoami
```

The D1 database, migration, split Secrets, and first deployment are complete.
Future migrations and deployments use:

```powershell
npm exec wrangler -- d1 migrations apply btc-futures-assistant --remote
npm exec wrangler -- deploy --secrets-file secrets/cloudflare-production.json --strict
```

The ignored `secrets/cloudflare-production.json` file contains the two distinct
production keys. Never print, commit, or transmit the complete file.

To configure the desktop app without printing the upload key:

```powershell
$relaySecrets = Get-Content -Raw secrets/cloudflare-production.json | ConvertFrom-Json
$relaySecrets.UPLOADER_WRITE_KEY | Set-Clipboard
Remove-Variable relaySecrets
```

Paste the clipboard value into the app's relay upload-key field, use the
production Worker URL above, connect, then clear the clipboard.

## Custom GPT Action

1. Confirm the server URL in `worker/openapi/openapi.json` matches the deployed
   `workers.dev` URL.
2. In the GPT editor, import that OpenAPI document.
3. Select API-key authentication, Bearer mode, and enter only the Action read
   key.
4. Test `getLatestSnapshot` and `validateTradePlan`.
5. Confirm a snapshot older than 15 seconds returns `analysisAllowed: false`.

No OpenAI API key is used.

Copy only the Action read key to the clipboard without printing it:

```powershell
$relaySecrets = Get-Content -Raw secrets/cloudflare-production.json | ConvertFrom-Json
$relaySecrets.ACTION_READ_KEY | Set-Clipboard
Remove-Variable relaySecrets
```

After saving the GPT Action, clear the clipboard.

## Key rotation

1. Generate two new independent 256-bit random keys in the ignored Secret file.
2. Deploy both with `--secrets-file`; never pass either value as a command
   argument.
3. Replace the desktop app upload key using the local settings screen.
4. Replace the Custom GPT Bearer key using only the Action read key.
5. Run both production relay smoke tests and clear the clipboard.

## Binance read-only account

Create a separate Binance API key with Futures read permission only. Disable
trading and withdrawals and restrict it to the PC's public IP. Enter the key and
secret in the app; do not place them in `.env`.

## Eight-hour soak

```powershell
$env:RUN_SOAK='1'
$env:SOAK_DURATION_MS='28800000'
npm run test:soak
```

## Clean Windows QA

Run `npm run make`, copy the generated Setup executable to a clean Windows 11
machine, install it, and verify launch, tray restore/quit, all four charts,
offline/stale blocking, clipboard/GPT handoff, relay fallback, optional account
connect/disconnect, restart persistence, and uninstall.
