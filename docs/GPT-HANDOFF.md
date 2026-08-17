# GPT Handoff

This document marks the boundary between program/research instrumentation work and GPT instruction iteration.

## Program-side research contract

The program now preserves and evaluates the evidence that GPT actually received at decision time. The research path is intentionally read-only and does not create a local directional engine.

1. Freeze `decision-context-v1` with each replay case.
2. Audit frozen context availability, freshness metadata, payload size, and completeness consistency.
3. Run matched evidence ablation on the same frozen cases.
4. Evaluate ENTER, WAIT_TRIGGER, NO_TRADE, and position-management behavior with Eval V2.
5. Compare path quality, latency, cost, missed opportunity, and decision mix separately.
6. Stratify results by objective frozen-input cohorts before interpreting profile deltas.

## Final research command

```bash
RELAY_URL=https://<relay> \
ACTION_READ_KEY=<read-key> \
npm run research:finalize -- <campaign-manifest.json> [output-prefix]
```

The command writes:

- `<output-prefix>.json` — full finalization report, including frozen-context audit and matched ablation evidence.
- `<output-prefix>.md` — final integrity gates, profile decision mix, adjacent decision-mix deltas, and GPT handoff state.
- `<output-prefix>.ablation.md` — detailed evidence-ablation/path-quality report.
- `<output-prefix>.context-audit.md` — detailed frozen Decision Context audit.

It does not call the paid OpenAI API, deploy production, promote a model/source, or activate trading.

## Read-only research endpoints

### `GET /v1/research/benchmark/{experimentId}`

Matched outcome, latency, cost, missed-opportunity, and execution-quality evidence.

### `GET /v1/research/path-quality/{experimentId}`

Eval V2 ENTER, WAIT_TRIGGER, and position-management path vectors.

### `GET /v1/research/decision-cohorts/{experimentId}`

Decision mix and cohort-stratified path evidence from existing final Eval V2 rows joined to the original frozen replay context.

The cohort endpoint uses two descriptive stratifications only:

- **Completeness:** `FULL_CORE`, `PARTIAL_CORE`, `LEGACY_INPUT` based on frozen context availability. Options and on-chain are not required for `FULL_CORE`, because they remain candidate ablation axes.
- **Regime:** BTC 15-minute realized volatility is split into empirical terciles over distinct frozen cases; BTC 1-hour `return12` is grouped by sign. These are descriptive cohort labels, not bullish/bearish signals.

## Finalization gate

`research:finalize` returns one of:

- `READY_FOR_MANUAL_RESEARCH_REVIEW`
- `BLOCKED_INCOMPLETE_RESEARCH_EVIDENCE`

Ready requires all of the following:

- every selected replay case is valid `decision-context-v1`;
- frozen completeness metadata has no detected contract mismatch;
- matched ablation comparison integrity is valid;
- Eval V2 path quality is available for every profile;
- decision-cohort results are available for every profile;
- scored cohort rows match the matched ablation case count;
- all cohort rows are backed by `decision-context-v1`;
- score/snapshot parsing has no silent failures;
- empirical regime definitions align across matched profiles.

This gate authorizes **manual research review only**. It does not produce `LIVE_CANDIDATE` or any automatic promotion decision.

## What GPT iteration may change

The next stage may change GPT instructions, prompt structure, context interpretation rules, confidence calibration, ENTER/WAIT/NO_TRADE reasoning, and position-management reasoning.

Any GPT change should be evaluated through the same frozen-case pipeline. In particular, do not interpret better MFE/MAE or trigger quality without checking whether the GPT simply changed the ENTER/WAIT/NO_TRADE mix.

## Evidence vectors that must remain separate

Do not collapse these into a single strategy score:

- directional accuracy and signed return;
- WAIT/NO_TRADE missed opportunity;
- ENTER MFE/MAE and TP-vs-stop ordering;
- WAIT_TRIGGER hit/invalidation/expiry/chase behavior;
- position-management path quality;
- decision mix;
- regime/completeness cohort behavior;
- latency;
- reported API cost.

## Invariants for the GPT phase

- No reconstruction of missing historical evidence from current data.
- Same frozen cases for profile comparisons.
- No local LONG/SHORT scoring engine.
- No hidden automatic source/model promotion.
- No scalar winner score.
- No production activation from research reports.
- Keep decision-class sample counts visible whenever comparing path metrics.
