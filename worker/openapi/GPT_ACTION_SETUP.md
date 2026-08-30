# GPT Action Setup

## Canonical versions

- OpenAPI **5.9.0** source: `worker/openapi/openapi.json`
- Instructions source: `worker/openapi/GPT_INSTRUCTIONS.md`
- GPT policy/telemetry instruction version: `gpt-policy-v3`
- Live Decision Context: `decision-context-v1`
- Internal Instructions budget: **7,500 characters maximum**
- Current GPT Builder UI limit observed in production setup: **8,000 characters maximum**
- Current GPT Builder operation-description compatibility limit observed in production setup: **300 characters maximum**

Use one current Instructions document and one current Action schema only. Historical append content remains available in Git history; do not append legacy fragments to the live GPT configuration.

`worker/openapi/openapi.json` remains the single source of truth for the Action contract. The Builder clipboard helper creates a deterministic Builder-safe projection from that source by shortening only over-limit operation descriptions. It does not change paths, operation IDs, parameters, request bodies, responses, security, server URL, or `x-openai-isConsequential`.

## Windows clipboard rule

Do **not** copy these UTF-8 files with bare Windows PowerShell `Get-Content ... -Raw | Set-Clipboard`. Windows PowerShell 5.1 can decode UTF-8-without-BOM using the active legacy code page, which corrupts Korean text and can inflate the apparent Builder character count.

Use the repository helper instead. It reads generated output with explicit strict UTF-8 decoding before changing the clipboard.

### Copy Instructions

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\copy-gpt-builder.ps1 -Target instructions
```

Replace the entire GPT Builder **Instructions** field with the clipboard contents. The copied text must begin with:

`# BTC Futures Assistant — GPT Policy v3`

Do not merge `GPT_ACTION_SETUP.md`, old appendices, or other documentation into the Instructions field.

### Copy Action schema

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\copy-gpt-builder.ps1 -Target schema
```

Replace the entire GPT Builder **Action schema** field with the clipboard contents. Do not hand-edit a partial schema in the Builder.

The generated schema is OpenAPI 3.1 JSON derived from `worker/openapi/openapi.json`. Builder compatibility normalization is limited to operation-description length; contract semantics remain unchanged and are regression-tested.

공식 live anchor는 `getDecisionSnapshot`이다. `getLatestSnapshot` remains detail/debug fallback only.

Expected operation IDs:

1. `getDecisionSnapshot` — official live Decision Context
2. `getLatestSnapshot` — detailed snapshot/debug fallback
3. `getExternalContext` — optional external expansion when requested by reasoning policy
4. `validateTradePlan` — deterministic ENTER_NOW plan validation
5. `validatePositionAdjustment` — deterministic position-management adjustment validation
6. `getTradeLifecycle` — approved-plan / lifecycle detail
7. `recordDecision` — analytics-only decision telemetry

If any operation is missing, rerun the Builder clipboard helper from the current `main`; do not repair the schema manually in the GPT editor.

## Repository verification

Before updating the Builder, run:

```powershell
npm run gpt:builder:check
```

This verifies:

- canonical Instructions remain valid UTF-8 and within the 7,500 internal / 8,000 Builder budgets;
- GPT Policy v3 identity is present;
- all seven operation IDs remain present;
- Builder operation descriptions are at most 300 characters after deterministic projection;
- HTTP Bearer auth remains intact.

The same compatibility checks run in `npm run check` and production preflight.

## Authentication

Configure the Action as API Key authentication using Bearer auth and the existing `ACTION_READ_KEY`.

Never use `UPLOADER_WRITE_KEY` in the Custom GPT. The upload key is only for the desktop-to-Worker snapshot write path.

## New-entry runtime order

1. Call `getDecisionSnapshot` and use that response's `snapshotId`, `marketGeneratedAt`, `generatedAt`, `decisionGates`, BTC core, crypto market, external evidence, memory, reasoning policy, and position-management context.
2. If the response already shows a live position or management lifecycle, stop new-entry analysis and switch to position management.
3. Apply `reasoningPolicy`. Call `getExternalContext` only when the current policy/instructions require external expansion.
4. `WAIT_TRIGGER` may include one GPT-authored structured trigger, but a local `TRIGGERED` event is only a request for fresh reanalysis.
5. Treat `ENTER_NOW` as provisional until `validateTradePlan` succeeds on the same current `snapshotId`. If validation blocks the candidate, reclassify the final user-facing action and preserve `planValidation=BLOCKED` in telemetry.
6. Call `recordDecision` exactly once immediately before the user-facing answer, with `instructionVersion=gpt-policy-v3` and `contextPackVersion=decision-context-v1`.

`recordDecision` is analytics-only telemetry. Its failure must not rewrite the market conclusion, bypass validation, or create invented trade values.

## WAIT trigger reanalysis

When an approved GPT trigger becomes `TRIGGERED`:

1. call a fresh `getDecisionSnapshot`;
2. re-evaluate the current market rather than treating the trigger as entry permission;
3. only a new GPT `ENTER_NOW` decision may proceed to `validateTradePlan`;
4. record the new decision with `recordDecision`.

## Position management runtime order

1. Call a fresh `getDecisionSnapshot` and prefer `positionManagement.actualProtection` plus the current Binance read-only position facts.
2. Use `getTradeLifecycle` only when additional approved-plan/lifecycle or protective-order detail is needed.
3. For exact `PARTIAL_EXIT`, `EXIT`, `MOVE_STOP`, or `CHANGE_TP` values, call `validatePositionAdjustment` with the same `snapshotId`.
4. Call `recordDecision` exactly once before answering, using the current GPT policy version.

## After Worker deployment

After deploying a Worker revision that changes Action-visible contracts:

1. run `npm run gpt:builder:check`;
2. copy the current Instructions with `copy-gpt-builder.ps1 -Target instructions`;
3. copy the generated Builder-safe Action schema with `copy-gpt-builder.ps1 -Target schema`;
4. confirm Bearer authentication still uses `ACTION_READ_KEY`;
5. use GPT Preview to test `getDecisionSnapshot` before relying on the GPT for live analysis.

The repository production runbook is `docs/PRODUCTION_READINESS.md`.
