# Feedback Loop Operations

## Purpose

This operating layer turns the Phase 24-25 research foundation into a repeatable feedback loop without adding a local trading signal or any Binance write capability.

The loop is:

1. accumulate live GPT decisions and actual outcomes;
2. freeze replay inputs before future outcomes exist;
3. select comparable historical cases without looking at future outcome values;
4. compare research candidates on the same frozen cases;
5. inspect original-decision quality plus executed-trade cost-adjusted Net R, drawdown, missed opportunity, latency and execution quality;
6. promote or revert only after manual evidence review.

## D1 migration safety

`npm run test:migrations` applies every file under `worker/migrations` in numeric order to an in-memory SQLite database and verifies the final research schema.

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

## Replay case catalog

Authenticated read-only endpoint:

`GET /v1/research/cases`

Supported filters include:

- `finalized=true|false`;
- `decision=ENTER_NOW|WAIT_TRIGGER|NO_TRADE|...`;
- `side=LONG|SHORT|NEUTRAL`;
- `analysisMode=FAST|VERIFY|DEEP`;
- `contextPackVersion`;
- `instructionVersion`;
- `after` / `before` market timestamps;
- `limit` from 1 to 500.

The catalog exposes identifiers, versions, fingerprint completeness and whether the future outcome has finalized. It intentionally does **not** expose future return or excursion values. This allows campaign selection without outcome-based cherry-picking.

## Original GPT decision quality

Authenticated read-only endpoint:

`GET /v1/research/decision-quality`

For finalized replay cases it separates:

- `ENTER_NOW`: 30m signed return, direction correctness and favorable/adverse excursion;
- `WAIT_TRIGGER` / `NO_TRADE`: future opportunity magnitude, without assigning an arbitrary scalar penalty;
- `DATA_BLOCKED`: count only;
- position-management decisions: count separately rather than pretending a 30m directional metric measures management quality.

It also provides descriptive cohorts by decision, analysis mode, instruction version, context version and confidence band. No scalar strategy score or automatic promotion decision is produced.

## Executed-trade performance feedback

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

## Balanced replay campaign preparation

A research campaign can be selected without manually copying decision IDs from D1.

For the current canonical GPT policy, keep the policy version and frozen context version distinct:

- `instructionVersion=gpt-policy-v3`
- `contextPackVersion=decision-context-v1`

The previous baseline is preserved at `research/gpt-policies/gpt-policy-v2.md` so matched replay comparisons do not depend on reconstructing old prompt text from memory.

Example campaign spec:

```json
{
  "registry": {
    "experimentId": "gpt-policy-v3-fast-001",
    "name": "GPT Policy v3 FAST",
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

The campaign tool normalizes the experiment registry to the strict replay experiment schema. The provider is forced to `OPENAI` because this campaign path produces OpenAI Batch input; unsupported extra registry keys are not forwarded.

With `RELAY_URL` and `ACTION_READ_KEY` set locally:

```powershell
npm run replay:campaign:prepare -- campaign-spec.json gpt-policy-v3-001
```

This queries only replay metadata plus outcome-finalization status, samples cases across the requested decision classes, and writes:

- `gpt-policy-v3-001.experiment.json` for the existing batch preparation step;
- `gpt-policy-v3-001.selection.json` as the audit manifest.

The selection algorithm samples across the available time range rather than simply taking the latest consecutive rows. If one decision class is sparse, remaining capacity is filled from other eligible classes. It never reads future return values.

The next step is still no-cost:

```powershell
npm run replay:batch:prepare -- gpt-policy-v3-001.experiment.json gpt-policy-v3-001.batch
```

This prepares OpenAI Batch JSONL only. Actual paid upload/execution remains outside these scripts and requires explicit approval.

Use `docs/GPT_POLICY_EVAL_MATRIX.md` as the behavioral review contract for policy candidates before interpreting outcome differences.

## No-cost report export

With `RELAY_URL` and `ACTION_READ_KEY` set locally:

```powershell
npm run research:report -- experiment-id-1 experiment-id-2
```

This writes ignored local files:

- `research-report.json`
- `research-report.md`

The report includes readiness, original GPT decision quality, executed-trade feedback, sizing research and optional experiment benchmarks. It reads existing research endpoints only and makes no paid OpenAI API call.

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
