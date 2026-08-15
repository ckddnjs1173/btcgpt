# Feedback Loop Operations

## Purpose

This batch turns the Phase 24-25 research foundation into an operational feedback loop without adding a local trading signal or any Binance write capability.

The loop remains:

1. accumulate live GPT decisions and actual outcomes;
2. freeze replay inputs before future outcomes exist;
3. compare research candidates on matched replay cases;
4. inspect live cost-adjusted Net R, drawdown, missed opportunity, latency and execution quality;
5. promote or revert only after manual evidence review.

## D1 migration safety

`npm run test:migrations` now applies every file under `worker/migrations` in numeric order to an in-memory SQLite database and verifies the final research schema.

Project policy also rejects `CREATE TRIGGER` in D1 migration files. The Phase 25 remote failure showed that complex trigger blocks are unnecessary operational risk for this project. Analytics enrichment belongs in Worker code while migrations remain statement-simple.

CI runs this migration-chain validation as part of `npm run check`.

## Research readiness

Authenticated read-only endpoint:

`GET /v1/research/readiness`

It reports:

- whether the Phase 25 performance schema is present;
- decision count and context-v2 adoption;
- replay-case and finalized-outcome inventory;
- experiment and scored-run counts;
- closed linked trades with realized Net R;
- benchmark/sizing evidence thresholds;
- deterministic next research actions.

It never promotes a model or changes live risk.

## Performance feedback

Authenticated read-only endpoint:

`GET /v1/research/feedback`

It reports only closed, decision-linked trades with `realized_net_r` and includes:

- mean/median Net R and win rate;
- MFE/MAE;
- planned-vs-actual entry drift;
- MFE capture ratio (`realized Net R / observed MFE R`) where MFE R is positive;
- recent 20 trades versus prior 20 trades Net R delta;
- descriptive cohorts by PAPER/LIVE mode, analysis mode, confidence band, context version and observed leverage bucket.

PAPER/LIVE and leverage cohorts are observational. They are not treated as causal leverage evidence and cannot mutate live size or leverage.

## No-cost report export

With `RELAY_URL` and `ACTION_READ_KEY` set locally:

```powershell
npm run research:report -- experiment-id-1 experiment-id-2
```

This writes ignored local files:

- `research-report.json`
- `research-report.md`

The report reads existing research endpoints only. It makes no paid OpenAI API call.

## One-command production apply

After a release is merged to `main`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\apply-production.ps1
```

The script:

1. switches to and pulls `main`;
2. validates the full local D1 migration chain;
3. lists and applies pending remote D1 migrations;
4. lists migrations again;
5. performs Worker dry-run and deploy;
6. optionally calls `/health` when `RELAY_URL` is set.

The script does not edit Custom GPT Instructions or Actions.

## Safety boundaries

Unchanged:

- no Binance order create/modify/cancel;
- no withdrawal or transfer;
- no local LONG/SHORT engine;
- no automatic model promotion;
- no automatic live sizing/leverage changes;
- no paid replay execution without explicit approval.
