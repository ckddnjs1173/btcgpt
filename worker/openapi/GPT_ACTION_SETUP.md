# GPT Action Setup

## Custom GPT instructions

Use **one current instruction file only**:

`worker/openapi/GPT_INSTRUCTIONS.md`

In the GPT editor, replace the entire Instructions field with that file. Do not append old Phase 13/confirmation/intelligence appendix files. They are historical migration notes and the editor has an 8,000-character instruction limit.

`GPT_INSTRUCTIONS.md` is intentionally kept below that limit and contains the current base behavior, decision telemetry, context-v2 trading memory, adaptive reasoning, and position-management rules.

## Canonical Action schema

The Custom GPT must use **one Action configuration only**. Paste the complete contents of:

`worker/openapi/openapi.json`

into that Action's OpenAPI schema field. Do not split market-data and decision-telemetry schemas into separate Actions.

Expected operation IDs:
1. `getLatestSnapshot`
2. `getExternalContext`
3. `validateTradePlan`
4. `getTradeLifecycle`
5. `recordDecision`

If any are missing, replace the Action schema with the current `worker/openapi/openapi.json`.

## Authentication

Use API Key authentication with Bearer auth and the existing `ACTION_READ_KEY`. Never use `UPLOADER_WRITE_KEY` in the Custom GPT.

## New-entry runtime order

1. `getLatestSnapshot`
2. analyze `decisionGates`, `intelligenceContext`, and `reasoningPolicy`
3. if final action is `ENTER_NOW`, `validateTradePlan` with the same `snapshotId`
4. `recordDecision`
5. answer the user

`recordDecision` is analytics-only telemetry. A telemetry failure must not rewrite the market conclusion or substitute invented trade values.
