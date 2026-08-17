# Production Readiness Runbook

## Purpose

This is the operator sequence for moving a tested repository revision into the live desktop → Cloudflare Worker/D1 → Custom GPT path.

It does not authorize exchange writes or automate trading. Binance BTCUSDT execution remains manual. Production readiness is about contract alignment, deployment correctness, freshness, and operational stability.

## 1. Synchronize and validate the Windows worktree

Use `main` only for a production deployment.

```powershell
git fetch origin
git checkout main
git pull --ff-only origin main
git status -sb

npm ci
npm run check
npm run format:check
npm run build
npm run ops:preflight
```

`ops:preflight` verifies repository-local production contracts without reading secret contents. It checks:

- Node 24+ / npm 11+
- clean `main` worktree and local `HEAD == origin/main`
- contiguous D1 migration filenames
- Wrangler Worker entrypoint, D1 binding/database/migration directory, and required secret names
- OpenAPI version alignment with `GPT_ACTION_SETUP.md`
- required GPT Action operation IDs
- HTTP Bearer `actionKey` authentication
- production Worker server URL
- `decision-context-v1` instruction anchor
- 7,500-character canonical Instructions budget
- existence of `secrets/cloudflare-production.json` without opening it

### Windows `npm ci` EPERM recovery

If `npm ci` fails because Electron/Node has a native `.node` file locked, close the BTC app and development processes first. If necessary:

```powershell
taskkill /F /IM electron.exe 2>$null
taskkill /F /IM node.exe 2>$null
Remove-Item -Recurse -Force node_modules
npm ci
```

Do not run `npm audit fix --force` as part of production deployment. Dependency upgrades belong in a separate tested PR.

## 2. Verify Cloudflare identity and compile before remote changes

```powershell
npm exec wrangler -- whoami
npm exec wrangler -- deploy --dry-run
```

The repository uses the locally installed Wrangler version from `package.json`. Keep the deployment in the account that owns the configured Worker and D1 database.

## 3. Inspect and apply D1 migrations

Use the stable database name rather than relying on the binding alias.

```powershell
npm exec wrangler -- d1 migrations list btc-futures-assistant --remote
npm exec wrangler -- d1 migrations apply btc-futures-assistant --remote
```

Read the migration list before confirming apply. The repository preflight verifies local sequence continuity, but only Wrangler can tell which migrations are pending on the remote D1 database.

Never upload synthetic production snapshots to test a migration.

## 4. Deploy the Worker

```powershell
npm exec wrangler -- deploy --secrets-file secrets/cloudflare-production.json --strict
```

The production secrets file must stay outside Git. Do not paste either secret into logs, chat, screenshots, or source files.

Required secrets remain:

- `UPLOADER_WRITE_KEY` — desktop snapshot upload only
- `ACTION_READ_KEY` — Custom GPT Action/read paths

The GPT must never receive `UPLOADER_WRITE_KEY`.

## 5. Start the current desktop build and verify fresh relay data

Start the application from the same `main` revision that passed validation. Confirm the Relay URL is:

```text
https://btc-futures-assistant-relay.btcgpt-ck1173.workers.dev
```

Wait for fresh snapshot turnover, then run the one-shot production smoke:

```powershell
$env:RELAY_PRODUCTION_URL='https://btc-futures-assistant-relay.btcgpt-ck1173.workers.dev'
$env:RELAY_SECRET_FILE='secrets/cloudflare-production.json'
npm run ops:postdeploy-smoke
Remove-Item Env:RELAY_PRODUCTION_URL -ErrorAction SilentlyContinue
Remove-Item Env:RELAY_SECRET_FILE -ErrorAction SilentlyContinue
```

The smoke script reads only `ACTION_READ_KEY` from the local secret file, never prints it, and checks the official `/v1/decision-context/latest` path for:

- `decision-context-v1`
- non-empty `snapshotId`
- `marketGeneratedAt` and `generatedAt`
- BTC `decisionGates`
- market age within the configured threshold (15 seconds by default)
- Action round-trip timing
- objective version presence for crypto/cross-venue/options/on-chain when those optional sources are available

Auxiliary evidence may legitimately be `null` or degraded. That alone is not a smoke failure and must not become a BTC entry blocker.

## 6. Refresh the Custom GPT configuration

After a Worker revision changes any Action-visible contract, update both GPT artifacts from the same repository revision.

### Action schema

Replace the Action schema with the complete contents of:

```text
worker/openapi/openapi.json
```

The current schema version is documented in `worker/openapi/GPT_ACTION_SETUP.md`. Configure API Key authentication using Bearer auth and `ACTION_READ_KEY`.

### Instructions

Replace the entire GPT Instructions field with:

```text
worker/openapi/GPT_INSTRUCTIONS.md
```

Do not append historical Phase instruction fragments.

### Preview validation

Before live analysis, use GPT Preview to test `getDecisionSnapshot`. The official live anchor is `getDecisionSnapshot`; `getLatestSnapshot` is detail/debug fallback only.

Expected Action operations are:

1. `getDecisionSnapshot`
2. `getLatestSnapshot`
3. `getExternalContext`
4. `validateTradePlan`
5. `validatePositionAdjustment`
6. `getTradeLifecycle`
7. `recordDecision`

A `TRIGGERED` WAIT condition is never entry permission. It requires a fresh `getDecisionSnapshot` and GPT reanalysis.

## 7. Run the operational soak ladder

First run the 30-minute Decision Context soak. Use the packaged app PID from Task Manager or PowerShell.

```powershell
$env:RELAY_PRODUCTION_URL='https://btc-futures-assistant-relay.btcgpt-ck1173.workers.dev'
$env:RELAY_SECRET_FILE='secrets/cloudflare-production.json'
$env:RELAY_APP_PID='<packaged-app-pid>'
$env:DECISION_CONTEXT_SOAK_DURATION_MS='1800000'
npm run test:decision-context-soak
```

Then promote through the duration/lifecycle ladder in `docs/OPERATIONAL_SOAK_MATRIX.md`:

1. 30 minutes
2. 2 hours
3. 6 hours
4. 24 hours
5. Windows sleep/resume
6. network disconnect/reconnect
7. materially high-volume session

Do not skip directly to a later soak and treat it as evidence that earlier failure modes were covered.

## 8. Research/evaluation after operational readiness

Once the live path is stable, use frozen replay/evaluation evidence rather than intuition to decide whether added data sources are useful.

Relevant commands include:

```powershell
npm run research:lead-lag
npm run research:ablation:prepare
npm run research:report
```

Evidence ablation remains cumulative and matched across the same frozen cases:

`BASELINE → LEAD_CORE → ALT_BREADTH → COINBASE → OPTIONS_V2 → ONCHAIN_V1`

Preparation is no-cost. Any paid OpenAI/API evaluation remains a separate explicitly authorized research path. No evidence source is promoted automatically.

## 9. Rollback boundary

If the Worker code itself must be rolled back, Wrangler supports Worker version rollback:

```powershell
npm exec wrangler -- rollback
```

This changes Worker code deployment only. **It does not roll back D1 migrations or data.** Before rolling Worker code back across a schema change, verify that the older Worker remains compatible with the already-applied D1 schema.

Do not write ad-hoc reverse SQL directly against production D1 during an incident. A database rollback requires a reviewed migration/recovery plan.

## Production acceptance checklist

A revision is operationally ready only when all applicable items are true:

- local `main` equals `origin/main` and worktree is clean
- `npm ci`, `npm run check`, `npm run format:check`, `npm run build`, and `npm run ops:preflight` pass
- remote D1 pending migrations are reviewed and applied
- strict Worker deployment succeeds
- fresh desktop snapshots reach the Worker
- `npm run ops:postdeploy-smoke` passes
- Custom GPT Action schema and Instructions come from the same repository revision
- GPT Preview can call `getDecisionSnapshot`
- 30-minute soak passes before longer soak promotion
- BTC critical freshness remains the only market-data class that can directly block new entry
- auxiliary source failure does not create a local direction signal or override BTC gate authority
- no Binance order/create/modify/cancel/withdraw/transfer write path exists

Operational readiness proves the path is functioning. It does not prove trading profitability.
