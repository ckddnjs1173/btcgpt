# Deployment and External Validation

## Cloudflare Worker and D1

Prerequisites: a Cloudflare account and Wrangler authenticated in the target
account.

```powershell
npm exec wrangler -- login
npm exec wrangler -- whoami
```

After authentication, let the implementation agent create D1, copy the returned
opaque database ID into `wrangler.toml`, generate two independent cryptographic
keys, apply migrations, set secrets, and deploy. The underlying commands are:

```powershell
npm exec wrangler -- d1 create btc-futures-assistant
npm exec wrangler -- d1 migrations apply btc-futures-assistant --remote
npm exec wrangler -- secret put UPLOADER_WRITE_KEY
npm exec wrangler -- secret put ACTION_READ_KEY
npm exec wrangler -- deploy
```

Do not reuse either key. Set `BTC_RELAY_URL` and `BTC_RELAY_UPLOAD_KEY` only in
the local process environment; never commit them.

## Custom GPT Action

1. Replace the server URL in `worker/openapi/openapi.json` with the deployed
   `workers.dev` URL.
2. In the GPT editor, import that OpenAPI document.
3. Select API-key authentication, Bearer mode, and enter only the Action read
   key.
4. Test `getLatestSnapshot` and `validateTradePlan`.
5. Confirm a snapshot older than 15 seconds returns `analysisAllowed: false`.

No OpenAI API key is used.

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
