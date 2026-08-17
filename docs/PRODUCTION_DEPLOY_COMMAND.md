# Guarded Production Deploy Command

`npm run ops:deploy` is a wrapper around the production-readiness runbook. It is intentionally read-only by default.

## Read-only plan

Run this first from a clean, synchronized `main` worktree:

```powershell
npm run ops:deploy
```

It runs, in order:

1. `ops:preflight`
2. `wrangler whoami`
3. `wrangler deploy --dry-run`
4. `wrangler d1 migrations list btc-futures-assistant --remote`

It does **not** apply migrations or deploy the Worker.

## Apply production changes

Only after reviewing the read-only output:

```powershell
npm run ops:deploy -- --apply --confirm=btc-futures-assistant-relay
```

Apply mode repeats the guarded checks and then runs:

1. remote D1 migrations apply
2. strict Worker deploy using `secrets/cloudflare-production.json` (or `RELAY_SECRET_FILE`)
3. authenticated `ops:postdeploy-smoke`

The explicit confirmation token prevents an accidental `--apply` from mutating production.

## Failure boundary

D1 migration application precedes Worker deployment. If migration application succeeds but a later deploy or smoke step fails, the database migration is **not** automatically rolled back. Follow `docs/PRODUCTION_READINESS.md` for rollback triage; Worker rollback and D1 data/schema recovery are separate operations.

The orchestrator does not place, modify, or cancel Binance orders and does not create local market-direction signals.
