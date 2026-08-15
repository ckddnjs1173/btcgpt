# Phase 13B — Decision → Plan → Trade Lineage

## Goal

Connect a GPT `ENTER_NOW` decision recorded in Worker D1 to the approved local plan and, when a position is actually opened, to the PAPER or LIVE trade outcome.

The purpose is evaluation lineage only:

`decisionId → planId → monitoring state → tradeId → outcome`

It does not create, modify, or cancel Binance orders and it does not generate a local LONG/SHORT signal.

## Automatic linking

The local app already uploads a sanitized compact snapshot that includes trading lifecycle state. Phase 13B reuses that existing upload instead of asking the user to copy a `decisionId` into the app.

For each uploaded `activePlan` or `lastPlan`, the Worker searches recent recorded decisions and links only when all of the following match exactly:

- decision = `ENTER_NOW`
- side matches
- planValidation = `VALIDATED`
- entry matches
- stop matches
- targets array matches
- decision was recorded within the bounded time window around the local plan lock

The link method is stored as `PLAN_VALUES_EXACT`.

If those fields do not match exactly, the Worker does **not** guess a relationship. Missing lineage is preferable to false attribution.

## Lifecycle updates

Once a plan is linked, subsequent compact snapshot uploads update the lineage record with objective state already produced by the app:

- plan status
- monitoring state
- triggered / invalidated / expired / cancelled timestamps
- PAPER or LIVE trade id when the trade carries the same plan id
- trade status and open/close timestamps
- available realized PnL / cost fields

The Worker stores only a bounded summary for lineage. It does not store hidden GPT reasoning, API credentials, order ids, or raw private Binance responses in the lineage record.

## Storage

Migration `0005_decision_trade_lineage.sql` adds explicit matching columns to `decision_log` and creates `decision_trade_lineage`.

Existing pre-Phase-13B decision rows keep default/null matching fields. New decisions recorded after the migration are eligible for automatic plan matching.

## Failure behavior

Lineage synchronization is analytics-only. If D1 lineage synchronization fails, the existing snapshot upload still succeeds and later snapshots retry naturally.

A lineage failure must not:

- alter market data
- change the GPT trading conclusion
- change plan monitoring
- open or close a trade
- block the relay

## Deployment order

1. Pull the merged code.
2. Apply D1 migration `0005_decision_trade_lineage.sql` to the remote database.
3. Deploy the Worker.
4. No Custom GPT Action schema or Instructions change is required for Phase 13B.

After deployment, future validated `ENTER_NOW` decisions can be linked automatically when the same approved values are locked in the local app.
