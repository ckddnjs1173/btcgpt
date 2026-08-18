# GPT Policy v2 ↔ v3 Matched Replay Preparation

## Goal

Compare `gpt-policy-v2` and `gpt-policy-v3` on the **same frozen `decision-context-v1` cases**. This procedure prepares matched inputs only. It does not upload or execute an OpenAI Batch and does not authorize paid API usage.

Canonical policy files:

- v2 baseline: `research/gpt-policies/gpt-policy-v2.md`
- v3 candidate: `worker/openapi/GPT_INSTRUCTIONS.md`

Behavioral review contract:

- `docs/GPT_POLICY_EVAL_MATRIX.md`

## 1. Select cases exactly once

Create one campaign spec that selects finalized `decision-context-v1` cases. Candidate-policy version is not a source-case filter; the selected historical cases are the common test set.

Example:

```json
{
  "registry": {
    "experimentId": "gpt-policy-v3-selection-001",
    "name": "GPT policy matched selection",
    "model": "MODEL_NAME",
    "modelVersion": null,
    "instructionVersion": "gpt-policy-v3",
    "contextPackVersion": "decision-context-v1",
    "analysisMode": "FAST",
    "enabledSources": [],
    "evaluatorVersion": "eval-v1"
  },
  "instructionsPath": "worker/openapi/GPT_INSTRUCTIONS.md",
  "sampleSize": 60,
  "decisionClasses": ["ENTER_NOW", "WAIT_TRIGGER", "NO_TRADE"],
  "contextPackVersion": "decision-context-v1"
}
```

With local `RELAY_URL` and `ACTION_READ_KEY`:

```powershell
npm run replay:campaign:prepare -- campaign-spec.json gpt-policy-pair-001
```

This produces:

- `gpt-policy-pair-001.experiment.json`
- `gpt-policy-pair-001.selection.json`

The selection manifest is the audit source of truth. Do **not** run a second independent case selection for v2.

## 2. Derive two experiments from the same decision IDs

Make two copies of `gpt-policy-pair-001.experiment.json`. Keep these fields identical in both copies:

- every `decisionIds` value and ordering;
- `registry.model` and `modelVersion`;
- `registry.contextPackVersion=decision-context-v1`;
- `registry.analysisMode`;
- `registry.enabledSources`;
- evaluator/replay settings.

Only policy-identifying fields and instruction text should differ.

### v2 experiment

Set:

```text
registry.experimentId = gpt-policy-v2-matched-001
registry.name = GPT Policy v2 matched replay
registry.instructionVersion = gpt-policy-v2
instructions = complete contents of research/gpt-policies/gpt-policy-v2.md
```

### v3 experiment

Set:

```text
registry.experimentId = gpt-policy-v3-matched-001
registry.name = GPT Policy v3 matched replay
registry.instructionVersion = gpt-policy-v3
instructions = complete contents of worker/openapi/GPT_INSTRUCTIONS.md
```

Do not reconstruct old policy text from memory and do not refresh historical evidence from current sources.

## 3. Prepare both Batch JSONL files — still no OpenAI execution

```powershell
npm run replay:batch:prepare -- gpt-policy-v2-matched-001.experiment.json gpt-policy-v2-matched-001.batch
npm run replay:batch:prepare -- gpt-policy-v3-matched-001.experiment.json gpt-policy-v3-matched-001.batch
```

`replay:batch:prepare` creates JSONL/manifests and registers the research experiment through the Relay, but it does **not** call the paid OpenAI API. Stop here unless paid Batch execution has been explicitly approved.

Before any later upload, verify both generated manifests contain the same decision IDs in the same order and the expected policy version/prompt hash lineage.

## 4. What v2 ↔ v3 is testing

The principal v3 hypothesis is behavioral, not directional:

1. `ENTER_NOW` is provisional until same-snapshot deterministic validation succeeds.
2. A validation-blocked ENTER candidate is reclassified to the appropriate final action rather than exposed as an executable plan.
3. That attempted validation remains observable as `planValidation=BLOCKED` instead of being erased as `NOT_APPLICABLE`.
4. `WAIT_TRIGGER` retains a one-sided LONG/SHORT thesis and does not become vague or two-sided waiting.

Do not expect or require v3 to produce more ENTERs, fewer ENTERs, or a higher scalar return score.

## 5. Review after scored runs exist

Use the existing research pipeline and keep evidence vectors separate:

- decision mix and per-class sample counts first;
- validation-blocked candidate count;
- ENTER direction/signed return/MFE/MAE/TP-vs-stop path;
- WAIT trigger hit/invalidation/expiry/chase and missed opportunity;
- NO_TRADE opportunity magnitude;
- management path quality where applicable;
- completeness/regime cohorts;
- latency and reported API cost.

Then run `research:finalize` for the matched campaign evidence. Its readiness result authorizes manual research review only; it does not auto-promote v3.

## Paid execution boundary

Uploading/executing either OpenAI Batch is intentionally outside this preparation procedure. Do not perform that step without explicit paid-API approval.
