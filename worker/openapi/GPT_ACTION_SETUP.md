# GPT Action Setup

## Canonical schema

The Custom GPT must use **one Action configuration only** for this project.

Paste the complete contents of:

`worker/openapi/openapi.json`

into that Action's OpenAPI schema field.

Do not split market-data and decision-telemetry schemas into separate Actions. The canonical schema intentionally exposes all supported GPT operations from the same Worker origin and the same Bearer credential.

## Expected detected operations

After the schema is accepted, the GPT editor must detect all five operation IDs:

1. `getLatestSnapshot`
2. `getExternalContext`
3. `validateTradePlan`
4. `getTradeLifecycle`
5. `recordDecision`

If `recordDecision` appears but `getLatestSnapshot` does not, the Action was configured with an obsolete telemetry-only schema. Replace the schema with `worker/openapi/openapi.json`.

If `getLatestSnapshot` appears but `recordDecision` does not, the GPT is still using the pre-Phase-13 schema. Pull the latest `main` branch and replace the schema with the current `worker/openapi/openapi.json`.

## Authentication

Use API Key authentication with Bearer auth and the same `ACTION_READ_KEY` used by the existing Worker Action endpoints.

Never use `UPLOADER_WRITE_KEY` in the Custom GPT.

## Runtime order for a new-entry question

1. `getLatestSnapshot`
2. analyze the returned snapshot and its `decisionGates`
3. if the final action is `ENTER_NOW`, call `validateTradePlan` using the same `snapshotId`
4. call `recordDecision` with the final structured decision
5. answer the user

`recordDecision` is analytics-only telemetry. A telemetry failure must not rewrite the market conclusion or substitute invented trade values.
