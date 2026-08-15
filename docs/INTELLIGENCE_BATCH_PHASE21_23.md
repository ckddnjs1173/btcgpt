# Intelligence Batch — Phase 21-23

## Scope

This batch activates three linked intelligence layers without adding a local LONG/SHORT engine.

1. **Phase 21 Trading Memory / Historical Analog**
   - builds the current `mf-v1` fingerprint from the live snapshot
   - compares it with up to 300 prior decision-linked fingerprints whose 60-minute replay outcome was already finalized before the current market timestamp
   - requires at least 30 overlapping features and 50% feature coverage
   - exposes at most five closest analogs with similarity, feature coverage, historical GPT decision metadata, and objective 5m/15m/30m/60m future paths
   - includes only historical information that was knowable before the current snapshot; the current case's future outcome is never included
   - historical outcome counts/medians are evidence only and are not converted into a current market signal

2. **Phase 22 Adaptive Reasoning / Critic routing**
   - emits `reasoning-v1` with `FAST | VERIFY | DEEP`
   - routing uses objective conditions such as data quality, degraded sources, cross-market completeness, event risk, and disagreement among sufficiently populated historical analogs
   - VERIFY asks GPT to check a counter-thesis/source gaps before committing
   - DEEP is reserved for event/venue/macro risk and may request one broader INTRADAY external-context call
   - reasoning depth never bypasses `decisionGates` and never supplies a directional recommendation

3. **Phase 23 Position-management intelligence**
   - derives current price-based R, distance to stop/targets, holding time, leverage/liquidation facts, protective coverage, and existing Phase 14 MFE/MAE/entry-quality telemetry when a plan can be linked
   - flags protection/data inconsistencies such as `STOP_COVERAGE_GAP`, `MANAGEMENT_DATA_BLOCKED`, and `PLAN_POSITION_MISMATCH`
   - does not generate HOLD/PARTIAL_EXIT/EXIT/MOVE_STOP/CHANGE_TP itself; GPT remains the decision owner

## Context contract

The live routed pack advances from `context-v1` to `context-v2` and adds:

- `tradingMemory: memory-v1`
- `reasoningPolicy: reasoning-v1`
- `positionManagement: management-v1`

Existing BTC core, cross-market and selected external context remain available.

For new decisions using `context-v2` the canonical GPT instructions require:

- `instructionVersion = phase23-v1`
- `contextPackVersion = context-v2`
- `analysisMode = reasoningPolicy.recommendedMode`

The exact enriched snapshot is still leased and promoted into Replay/Eval, so later experiments replay what the live GPT actually saw.

## Leakage and safety rules

- Historical analog candidates must have `replay_case_outcomes.finalized_at <= current marketGeneratedAt`.
- The current replay case's future path is never present in live context.
- Similarity is deterministic market-state similarity, not probability of profit.
- No local bullish/bearish classifier, LONG/SHORT score or automated trade action is added.
- No Binance create/modify/cancel/withdraw/transfer capability is added.
- A failure in memory or management enrichment degrades to `UNAVAILABLE`/missing telemetry rather than blocking live BTC analysis.

## Deployment

This batch has no new D1 migration and no desktop runtime changes.

After merge:

1. `git pull origin main`
2. `npx wrangler deploy --dry-run`
3. `npx wrangler deploy`
4. replace the entire Custom GPT Instructions field with `worker/openapi/GPT_INSTRUCTIONS.md`

No Action schema or authentication change is required.
