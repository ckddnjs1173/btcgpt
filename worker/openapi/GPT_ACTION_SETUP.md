# GPT Action Setup

## Canonical versions

- OpenAPI **5.9.0**: `worker/openapi/openapi.json`
- Instructions: `worker/openapi/GPT_INSTRUCTIONS.md`
- Live Decision Context: `decision-context-v1`
- Instruction budget: **7,500 characters maximum**

Use one current Instructions document and one current Action schema only. Historical Phase append files are migration notes; do not append them to the live GPT configuration.

## Custom GPT instructions

In the GPT editor, replace the entire Instructions field with the complete contents of:

`worker/openapi/GPT_INSTRUCTIONS.md`

Do not merge old instruction appendices into it. The repository test and production preflight both enforce the 7,500-character budget.

## Canonical Action schema

Create or update a single GPT Action using the complete contents of:

`worker/openapi/openapi.json`

The official live anchor is `getDecisionSnapshot`. `getLatestSnapshot` remains detail/debug fallback only.

Expected operation IDs:

1. `getDecisionSnapshot` — official live Decision Context
2. `getLatestSnapshot` — detailed snapshot/debug fallback
3. `getExternalContext` — optional external expansion when requested by reasoning policy
4. `validateTradePlan` — deterministic ENTER_NOW plan validation
5. `validatePositionAdjustment` — deterministic position-management adjustment validation
6. `getTradeLifecycle` — approved-plan / lifecycle detail
7. `recordDecision` — analytics-only decision telemetry

If any operation is missing, replace the Action schema with the current `worker/openapi/openapi.json`; do not hand-edit a partial schema in the GPT editor.

## Authentication

Configure the Action as API Key authentication using Bearer auth and the existing `ACTION_READ_KEY`.

Never use `UPLOADER_WRITE_KEY` in the Custom GPT. The upload key is only for the desktop-to-Worker snapshot write path.

## New-entry runtime order

1. Call `getDecisionSnapshot` and use that response's `snapshotId`, `marketGeneratedAt`, `generatedAt`, `decisionGates`, BTC core, crypto market, external evidence, memory, reasoning policy, and position-management context.
2. If the response already shows a live position or management lifecycle, stop new-entry analysis and switch to position management.
3. Apply `reasoningPolicy`. Call `getExternalContext` only when the current policy/instructions require external expansion.
4. `WAIT_TRIGGER` may include one GPT-authored structured trigger, but a local `TRIGGERED` event is only a request for fresh reanalysis.
5. For `ENTER_NOW`, call `validateTradePlan` with the same current `snapshotId`. A changed snapshot requires fresh `getDecisionSnapshot` analysis.
6. Call `recordDecision` exactly once immediately before the user-facing answer.

`recordDecision` is analytics-only telemetry. Its failure must not rewrite the market conclusion, bypass validation, or create invented trade values.

## WAIT trigger reanalysis

When an approved GPT trigger becomes `TRIGGERED`:

1. call a fresh `getDecisionSnapshot`;
2. re-evaluate the current market rather than treating the trigger as entry permission;
3. only a new GPT `ENTER_NOW` decision may proceed to `validateTradePlan`;
4. record the new decision with `recordDecision`.

## Position management runtime order

1. Call a fresh `getDecisionSnapshot`.
2. Use `getTradeLifecycle` only when approved-plan/lifecycle detail is needed.
3. For exact `PARTIAL_EXIT`, `EXIT`, `MOVE_STOP`, or `CHANGE_TP` values, call `validatePositionAdjustment` with the same `snapshotId`.
4. Call `recordDecision` exactly once before answering.

## After Worker deployment

After deploying a Worker revision that changes Action-visible contracts:

1. replace the GPT Action schema with the current `worker/openapi/openapi.json`;
2. replace the GPT Instructions with the current `worker/openapi/GPT_INSTRUCTIONS.md`;
3. confirm Bearer authentication still uses `ACTION_READ_KEY`;
4. use GPT Preview to test `getDecisionSnapshot` before relying on the GPT for live analysis.

The repository production runbook is `docs/PRODUCTION_READINESS.md`.
