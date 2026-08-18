# GPT Policy v2 Evaluation Matrix

## Purpose

This matrix defines behavioral contracts for evaluating `gpt-policy-v2` on frozen `decision-context-v1` cases. It is not a trading strategy, does not define numeric market thresholds, and must not be converted into a local LONG/SHORT scoring engine.

Use it to review whether a GPT policy change altered the intended decision semantics before interpreting outcome metrics.

## Version contract

- `instructionVersion=gpt-policy-v2`
- `contextPackVersion=decision-context-v1`
- Same frozen cases for policy comparisons.
- Current-case future outcome is never visible to the GPT.
- Decision mix and per-decision sample counts remain visible alongside path metrics.

## Behavioral scenarios

| ID | Frozen-input condition | Expected policy behavior | Forbidden shortcut |
|---|---|---|---|
| G01 | `marketAnalysisAvailable=false` | `DATA_BLOCKED`, `confidenceBand=NONE`; report blocker/recovery source only | Creating LONG/SHORT thesis, WAIT setup, Entry/TP/SL |
| G02 | Analysis available but `entryAllowed=false` | Market explanation may continue; `WAIT_TRIGGER` only if a one-sided trigger + invalidation is genuinely definable, otherwise `NO_TRADE` | Treating analysis availability as entry permission |
| G03 | Clear one-sided BTC structure, at least one independent current confirmation, definable invalidation, no material conflict, no chase | `ENTER_NOW` may be considered; same-snapshot `validateTradePlan` is mandatory before exact plan output | ENTER from auxiliary evidence alone or without validation |
| G04 | BTC core is mixed/unclear while crypto-market/options/memory lean strongly one way | Do not let corroboration override the core; usually `NO_TRADE`, or `WAIT_TRIGGER` only when one concrete core confirmation is missing and definable | Majority-vote or scalar evidence score |
| G05 | One-sided BTC thesis exists, but one material confirmation is pending and a precise trigger/invalidation can be stated | `WAIT_TRIGGER` with exactly one GPT-authored trigger contract | Vague WAIT with no actionable trigger or two-sided trigger fishing |
| G06 | Both long and short theses remain materially plausible, or risk/reward cannot be defined coherently | `NO_TRADE` | Forcing WAIT merely to keep a trade alive |
| G07 | `orderBookSynchronized=false`, while other BTC core data remains valid | Exclude wall/imbalance/microprice/order-book slippage evidence and continue with remaining valid evidence | Using unsynchronized book or converting it alone into `DATA_BLOCKED` |
| G08 | Auxiliary ETH/SOL/alt/options/on-chain data is stale/degraded, but BTC gate/core is valid | Continue BTC analysis with those auxiliary sources removed/down-weighted | `DATA_BLOCKED` from auxiliary staleness alone |
| G09 | WAIT trigger later reports `TRIGGERED` | Call a fresh `getDecisionSnapshot` and re-analyze from scratch; only a new decision can become `ENTER_NOW` | Treating `TRIGGERED` as entry authorization |
| G10 | Core thesis and multiple independent confirmations align with no material core degradation | `HIGH` confidence may be used, but action still follows ENTER/WAIT/NO_TRADE rules | HIGH because auxiliary markets agree, or HIGH => automatic ENTER |
| G11 | Live position has `STOP_COVERAGE_GAP` | Put protection warning first; management remains anchored to actual Binance position and same-snapshot validation for exact changes | Ignoring protection gap to optimize profit |
| G12 | Position is profitable but original invalidation remains intact and current structure/flow do not justify a change | Do not move stop/TP merely because price-R/MFE is positive; `HOLD` may remain correct | Automatic breakeven/trailing behavior from profit alone |
| G13 | Position structure/invalidation materially fails | Consider `EXIT`, `PARTIAL_EXIT`, or protection change according to current evidence; validate exact Binance values | Waiting for MFE/MAE thresholds to override structural failure |
| G14 | Multiple fields are derived from the same underlying source/calculation | Count them as one evidence lineage for independence purposes | Inflating confidence by double-counting correlated features |

## Review dimensions

For each policy candidate, review these dimensions separately rather than producing one winner score:

1. **Decision semantics:** Are G01-G14 respected?
2. **Decision mix:** ENTER / WAIT / NO_TRADE / DATA_BLOCKED / management counts and rates.
3. **ENTER path quality:** MFE, MAE, TP-vs-stop ordering, signed return, direction correctness.
4. **WAIT path quality:** trigger hit, invalidation, expiry, chase behavior, missed opportunity.
5. **NO_TRADE opportunity:** future opportunity magnitude without inventing a scalar penalty.
6. **Management path quality:** protection coverage, subsequent MFE/MAE, exit/adjustment path behavior.
7. **Cohorts:** completeness and descriptive regime cohorts from the frozen input.
8. **Operational cost:** latency and reported API cost.

A policy is not better merely because it ENTERs less, WAITs more, or shows better MFE on the reduced ENTER subset. Always inspect decision-mix shifts and sample counts first.

## Policy-change checklist

Before merging a future `gpt-policy-vN` change:

- state the exact behavioral hypothesis;
- identify which G01-G14 scenarios it is intended to affect;
- keep unrelated contracts unchanged where possible;
- bump `instructionVersion` when behavior changes materially;
- keep `contextPackVersion` tied to the actual frozen context schema;
- run repository CI;
- evaluate the change on the same frozen cases before any production activation;
- use `research:finalize` and manual evidence review; never auto-promote from one metric.
