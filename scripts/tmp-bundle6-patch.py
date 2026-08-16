import json
from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'missing block in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# Replay path storage + 1m/3m horizons.
p = Path('worker/src/phase16-replay.ts')
text = p.read_text(encoding='utf-8')
if "from './evaluation-v2'" not in text:
    text = text.replace(
        "import type { Env } from './index';\n",
        "import type { Env } from './index';\nimport {\n  evaluateEnterPlan,\n  evaluateManagementDecision,\n  evaluateWaitTrigger,\n  parsePricePathJson,\n} from './evaluation-v2';\nimport { structuredTriggerInputSchema } from '../../src/shared/trading/structured-trigger';\n",
        1,
    )
text = text.replace(
    """const OUTCOME_HORIZONS = [
  ['5m', 5 * 60_000],
  ['15m', 15 * 60_000],
  ['30m', 30 * 60_000],
  ['60m', 60 * 60_000],
] as const;""",
    """const OUTCOME_HORIZONS = [
  ['1m', 60_000],
  ['3m', 3 * 60_000],
  ['5m', 5 * 60_000],
  ['15m', 15 * 60_000],
  ['30m', 30 * 60_000],
  ['60m', 60 * 60_000],
] as const;""",
    1,
)
text = text.replace(
    """  maxUpBps5m: number | null;
  maxDownBps5m: number | null;
  returnBps5m: number | null;
  returnObservedAt5m: number | null;""",
    """  maxUpBps1m: number | null;
  maxDownBps1m: number | null;
  returnBps1m: number | null;
  returnObservedAt1m: number | null;
  maxUpBps3m: number | null;
  maxDownBps3m: number | null;
  returnBps3m: number | null;
  returnObservedAt3m: number | null;
  maxUpBps5m: number | null;
  maxDownBps5m: number | null;
  returnBps5m: number | null;
  returnObservedAt5m: number | null;""",
    1,
)
text = text.replace(
    """  returnBps60m: number | null;
  returnObservedAt60m: number | null;
  finalizedAt: number | null;""",
    """  returnBps60m: number | null;
  returnObservedAt60m: number | null;
  pricePathVersion: string;
  pricePathJson: string;
  lastPathObservedAt: number | null;
  finalizedAt: number | null;""",
    1,
)
marker = """function horizonAssignments(
  suffix: (typeof OUTCOME_HORIZONS)[number][0],
  horizonMs: number,
): string {"""
path_helper = """function pricePathAssignments(): string {
  const age = '(?1 - market_generated_at)';
  const interval = `CASE
    WHEN ${age} <= ${5 * 60_000} THEN 5000
    WHEN ${age} <= ${15 * 60_000} THEN 15000
    ELSE 30000 END`;
  const due = `(${age} > 0 AND ${age} <= ${60 * 60_000}
    AND (last_path_observed_at IS NULL OR (?1 - last_path_observed_at) >= (${interval})))`;
  return `
    price_path_json=CASE WHEN ${due}
      THEN json_insert(COALESCE(price_path_json, '[]'), '$[#]', json_array(${age}, ?2))
      ELSE price_path_json END,
    last_path_observed_at=CASE WHEN ${due}
      THEN ?1 ELSE last_path_observed_at END`;
}

"""
if 'function pricePathAssignments()' not in text:
    if marker not in text:
        raise SystemExit('missing horizonAssignments marker')
    text = text.replace(marker, path_helper + marker, 1)
text = text.replace(
    """  const assignments = OUTCOME_HORIZONS.map(([suffix, horizonMs]) =>
    horizonAssignments(suffix, horizonMs),
  ).join(',');
  const result = await env.DB.prepare(
    `UPDATE replay_case_outcomes SET
      first_future_observed_at=COALESCE(first_future_observed_at, ?1),
      last_future_observed_at=?1,
      sample_count=sample_count + 1,
      ${assignments},
      finalized_at=CASE""",
    """  const assignments = OUTCOME_HORIZONS.map(([suffix, horizonMs]) =>
    horizonAssignments(suffix, horizonMs),
  ).join(',');
  const pathAssignments = pricePathAssignments();
  const result = await env.DB.prepare(
    `UPDATE replay_case_outcomes SET
      first_future_observed_at=COALESCE(first_future_observed_at, ?1),
      last_future_observed_at=?1,
      sample_count=sample_count + 1,
      ${assignments},
      ${pathAssignments},
      finalized_at=CASE""",
    1,
)
text = text.replace(
    """      sample_count AS sampleCount,
      max_up_bps_5m AS maxUpBps5m, max_down_bps_5m AS maxDownBps5m,""",
    """      sample_count AS sampleCount,
      max_up_bps_1m AS maxUpBps1m, max_down_bps_1m AS maxDownBps1m,
      return_bps_1m AS returnBps1m, return_observed_at_1m AS returnObservedAt1m,
      max_up_bps_3m AS maxUpBps3m, max_down_bps_3m AS maxDownBps3m,
      return_bps_3m AS returnBps3m, return_observed_at_3m AS returnObservedAt3m,
      max_up_bps_5m AS maxUpBps5m, max_down_bps_5m AS maxDownBps5m,""",
    1,
)
text = text.replace(
    """      return_bps_60m AS returnBps60m, return_observed_at_60m AS returnObservedAt60m,
      finalized_at AS finalizedAt""",
    """      return_bps_60m AS returnBps60m, return_observed_at_60m AS returnObservedAt60m,
      price_path_version AS pricePathVersion, price_path_json AS pricePathJson,
      last_path_observed_at AS lastPathObservedAt, finalized_at AS finalizedAt""",
    1,
)
helper_anchor = """async function readReplayOutcome(
  env: Env,
  decisionId: string,
): Promise<Response> {"""
helper = r'''function decisionEvaluationV2(input: {
  decision: DecisionOutcomeRow;
  outcome: ReplayOutcomeRow | null;
  tradeQuality: TradeQualityRow | null;
}): unknown {
  const { decision, outcome, tradeQuality } = input;
  if (!outcome || outcome.anchorMarkPrice === null)
    return { available: false, reason: 'OUTCOME_UNAVAILABLE' };
  const pricePath = parsePricePathJson(outcome.pricePathJson);
  if (pricePath.length === 0)
    return { available: false, reason: 'PRICE_PATH_UNAVAILABLE' };
  const payload = asRecord(safeParse(decision.payload));
  const side =
    decision.side === 'LONG' || decision.side === 'SHORT'
      ? decision.side
      : 'NEUTRAL';

  if (decision.decision === 'ENTER_NOW' && side !== 'NEUTRAL') {
    const entry = asNumber(payload?.entry);
    const stop = asNumber(payload?.stop);
    const targets = Array.isArray(payload?.targets)
      ? payload.targets.map(asNumber).filter((value): value is number => value !== null)
      : [];
    if (entry === null || stop === null || targets.length === 0)
      return { available: false, reason: 'PLAN_UNAVAILABLE' };
    return evaluateEnterPlan({
      side,
      anchorMarkPrice: outcome.anchorMarkPrice,
      entry,
      stop,
      targets,
      pricePath,
      realizedNetR: tradeQuality?.realizedNetR ?? null,
      entryDriftBps: tradeQuality?.entryDriftBps ?? null,
    });
  }

  if (decision.decision === 'WAIT_TRIGGER') {
    const parsedTrigger = structuredTriggerInputSchema.safeParse(payload?.triggerContract);
    if (!parsedTrigger.success)
      return { available: false, reason: 'STRUCTURED_TRIGGER_UNAVAILABLE' };
    return evaluateWaitTrigger({
      side,
      marketGeneratedAt: outcome.marketGeneratedAt,
      anchorMarkPrice: outcome.anchorMarkPrice,
      triggerContract: parsedTrigger.data,
      pricePath,
    });
  }

  if (
    decision.decision === 'HOLD' ||
    decision.decision === 'PARTIAL_EXIT' ||
    decision.decision === 'EXIT' ||
    decision.decision === 'MOVE_STOP' ||
    decision.decision === 'CHANGE_TP'
  ) {
    return evaluateManagementDecision({
      decision: decision.decision,
      side,
      anchorMarkPrice: outcome.anchorMarkPrice,
      pricePath,
      realizedNetR: tradeQuality?.realizedNetR ?? null,
    });
  }

  return {
    available: true,
    decision: decision.decision,
    performanceScored: false,
    note:
      decision.decision === 'NO_TRADE'
        ? 'NO_TRADE is described by future opportunity vectors; no scalar penalty is assigned.'
        : 'DATA_BLOCKED is counted but not performance-scored.',
  };
}

'''
if 'function decisionEvaluationV2' not in text:
    if helper_anchor not in text:
        raise SystemExit('missing readReplayOutcome anchor')
    text = text.replace(helper_anchor, helper + helper_anchor, 1)
text = text.replace(
    """    futurePath: outcome,
    tradeQuality,
    samplingBasis: 'RELAY_MARK_PRICE',""",
    """    futurePath: outcome
      ? {
          ...outcome,
          pricePath: parsePricePathJson(outcome.pricePathJson),
        }
      : null,
    tradeQuality,
    evaluationV2: decisionEvaluationV2({ decision, outcome, tradeQuality }),
    samplingBasis: 'RELAY_MARK_PRICE',""",
    1,
)
p.write_text(text, encoding='utf-8')

# Decision telemetry stores the same structured WAIT contract.
p = Path('worker/src/phase13.ts')
text = p.read_text(encoding='utf-8')
if 'structuredTriggerInputSchema' not in text:
    text = text.replace(
        "import { z } from 'zod';\n",
        "import { z } from 'zod';\n\nimport { structuredTriggerInputSchema } from '../../src/shared/trading/structured-trigger';\n",
        1,
    )
text = text.replace(
    """    triggerSummary: z.string().trim().max(300).nullable().optional(),
    invalidationSummary: z.string().trim().max(300).nullable().optional(),""",
    """    triggerSummary: z.string().trim().max(300).nullable().optional(),
    triggerContract: structuredTriggerInputSchema.nullable().optional(),
    invalidationSummary: z.string().trim().max(300).nullable().optional(),""",
    1,
)
anchor = """    if (decision.decision === 'ENTER_NOW') {"""
addition = """    if (decision.triggerContract) {
      if (decision.decision !== 'WAIT_TRIGGER') {
        context.addIssue({
          code: 'custom',
          path: ['triggerContract'],
          message: 'triggerContract is only valid for WAIT_TRIGGER',
        });
      }
      if (decision.triggerContract.decisionId !== decision.decisionId) {
        context.addIssue({
          code: 'custom',
          path: ['triggerContract', 'decisionId'],
          message: 'triggerContract decisionId must match decisionId',
        });
      }
      if (decision.triggerContract.sourceSnapshotId !== decision.snapshotId) {
        context.addIssue({
          code: 'custom',
          path: ['triggerContract', 'sourceSnapshotId'],
          message: 'triggerContract sourceSnapshotId must match snapshotId',
        });
      }
    }
    if (decision.decision === 'ENTER_NOW') {"""
if 'triggerContract is only valid for WAIT_TRIGGER' not in text:
    if anchor not in text:
        raise SystemExit('missing decision refine anchor')
    text = text.replace(anchor, addition, 1)
p.write_text(text, encoding='utf-8')

# Eval registry/scorer: keep eval-v1 immutable and add eval-v2.
p = Path('worker/src/phase16-eval.ts')
text = p.read_text(encoding='utf-8')
if "from './evaluation-v2'" not in text:
    text = text.replace(
        "import { REPLAY_CASE_VERSION } from './phase16-replay';\n",
        "import { REPLAY_CASE_VERSION } from './phase16-replay';\nimport {\n  EVALUATION_V2_VERSION,\n  evaluateEnterPlan,\n  evaluateManagementDecision,\n  evaluateWaitTrigger,\n  parsePricePathJson,\n} from './evaluation-v2';\nimport { structuredTriggerInputSchema } from '../../src/shared/trading/structured-trigger';\n",
        1,
    )
text = text.replace(
    "export const EVALUATOR_VERSION = 'eval-v1';",
    "export const EVALUATOR_VERSION = EVALUATION_V2_VERSION;\nconst evaluatorVersionSchema = z.enum(['eval-v1', 'eval-v2']);",
    1,
)
text = text.replace(
    "evaluatorVersion: z.literal(EVALUATOR_VERSION).default(EVALUATOR_VERSION),",
    "evaluatorVersion: evaluatorVersionSchema.default(EVALUATOR_VERSION),",
    1,
)
text = text.replace(
    "outputVersion: z.literal('eval-output-v1').default('eval-output-v1'),",
    "outputVersion: z\n      .enum(['eval-output-v1', 'eval-output-v2'])\n      .default('eval-output-v2'),",
    1,
)
text = text.replace(
    """    triggerSummary: z.string().trim().max(300).nullable().optional(),
    invalidationSummary: z.string().trim().max(300).nullable().optional(),""",
    """    triggerSummary: z.string().trim().max(300).nullable().optional(),
    triggerContract: structuredTriggerInputSchema.nullable().optional(),
    invalidationSummary: z.string().trim().max(300).nullable().optional(),""",
    1,
)
super_anchor = """  .superRefine((output, context) => {
    if (output.decision !== 'ENTER_NOW') return;"""
super_new = """  .superRefine((output, context) => {
    if (
      output.outputVersion === 'eval-output-v2' &&
      output.decision === 'WAIT_TRIGGER' &&
      !output.triggerContract
    ) {
      context.addIssue({
        code: 'custom',
        path: ['triggerContract'],
        message: 'eval-output-v2 WAIT_TRIGGER requires triggerContract',
      });
    }
    if (output.triggerContract && output.decision !== 'WAIT_TRIGGER') {
      context.addIssue({
        code: 'custom',
        path: ['triggerContract'],
        message: 'triggerContract is only valid for WAIT_TRIGGER',
      });
    }
    if (output.decision !== 'ENTER_NOW') return;"""
if super_anchor not in text:
    raise SystemExit('missing eval superRefine anchor')
text = text.replace(super_anchor, super_new, 1)
text = text.replace(
    "type HorizonKey = '5m' | '15m' | '30m' | '60m';",
    "type HorizonKey = '1m' | '3m' | '5m' | '15m' | '30m' | '60m';",
    1,
)
text = text.replace(
    """type OutcomeRow = {
  finalizedAt: number | null;
  maxUpBps5m: number | null;""",
    """type OutcomeRow = {
  finalizedAt: number | null;
  anchorMarkPrice: number | null;
  marketGeneratedAt: number;
  maxUpBps1m: number | null;
  maxDownBps1m: number | null;
  returnBps1m: number | null;
  maxUpBps3m: number | null;
  maxDownBps3m: number | null;
  returnBps3m: number | null;
  maxUpBps5m: number | null;""",
    1,
)
text = text.replace(
    """  returnBps60m: number | null;
};""",
    """  returnBps60m: number | null;
  pricePathJson: string;
};""",
    1,
)
text = text.replace(
    """      `SELECT finalized_at AS finalizedAt,
        max_up_bps_5m AS maxUpBps5m,""",
    """      `SELECT finalized_at AS finalizedAt,
        market_generated_at AS marketGeneratedAt,
        anchor_mark_price AS anchorMarkPrice,
        max_up_bps_1m AS maxUpBps1m,
        max_down_bps_1m AS maxDownBps1m,
        return_bps_1m AS returnBps1m,
        max_up_bps_3m AS maxUpBps3m,
        max_down_bps_3m AS maxDownBps3m,
        return_bps_3m AS returnBps3m,
        max_up_bps_5m AS maxUpBps5m,""",
    1,
)
text = text.replace(
    """        max_down_bps_60m AS maxDownBps60m,
        return_bps_60m AS returnBps60m
       FROM replay_case_outcomes""",
    """        max_down_bps_60m AS maxDownBps60m,
        return_bps_60m AS returnBps60m,
        price_path_json AS pricePathJson
       FROM replay_case_outcomes""",
    1,
)
horizon_anchor = """function horizonValues(
  outcome: OutcomeRow,
  horizon: HorizonKey,
): { rawReturn: number | null; maxUp: number | null; maxDown: number | null } {
  if (horizon === '5m') {"""
horizon_new = """function horizonValues(
  outcome: OutcomeRow,
  horizon: HorizonKey,
): { rawReturn: number | null; maxUp: number | null; maxDown: number | null } {
  if (horizon === '1m') {
    return {
      rawReturn: outcome.returnBps1m,
      maxUp: outcome.maxUpBps1m,
      maxDown: outcome.maxDownBps1m,
    };
  }
  if (horizon === '3m') {
    return {
      rawReturn: outcome.returnBps3m,
      maxUp: outcome.maxUpBps3m,
      maxDown: outcome.maxDownBps3m,
    };
  }
  if (horizon === '5m') {"""
if horizon_anchor not in text:
    raise SystemExit('missing horizonValues anchor')
text = text.replace(horizon_anchor, horizon_new, 1)
score_anchor = """async function scoreRun(
  env: Env,"""
score_helper = r'''function allHorizonScores(outcome: OutcomeRow, side: EvalOutput['side']) {
  return {
    '1m': scoreHorizon(side, horizonValues(outcome, '1m')),
    '3m': scoreHorizon(side, horizonValues(outcome, '3m')),
    '5m': scoreHorizon(side, horizonValues(outcome, '5m')),
    '15m': scoreHorizon(side, horizonValues(outcome, '15m')),
    '30m': scoreHorizon(side, horizonValues(outcome, '30m')),
    '60m': scoreHorizon(side, horizonValues(outcome, '60m')),
  } satisfies Record<HorizonKey, HorizonScore>;
}

function scoreRunV2FromOutcome(outcome: OutcomeRow, output: EvalOutput) {
  const directionalSide = output.decision === 'ENTER_NOW' ? output.side : 'NEUTRAL';
  const horizons = allHorizonScores(outcome, directionalSide);
  const pricePath = parsePricePathJson(outcome.pricePathJson);
  let decisionEvaluation: unknown;

  if (
    output.decision === 'ENTER_NOW' &&
    output.side !== 'NEUTRAL' &&
    output.entry != null &&
    output.stop != null
  ) {
    decisionEvaluation = evaluateEnterPlan({
      side: output.side,
      anchorMarkPrice: outcome.anchorMarkPrice ?? output.entry,
      entry: output.entry,
      stop: output.stop,
      targets: output.targets,
      pricePath,
    });
  } else if (output.decision === 'WAIT_TRIGGER' && output.triggerContract) {
    decisionEvaluation = evaluateWaitTrigger({
      side: output.side,
      marketGeneratedAt: outcome.marketGeneratedAt,
      anchorMarkPrice: outcome.anchorMarkPrice ?? output.triggerContract.triggerPrice,
      triggerContract: output.triggerContract,
      pricePath,
    });
  } else if (
    output.decision === 'HOLD' ||
    output.decision === 'PARTIAL_EXIT' ||
    output.decision === 'EXIT' ||
    output.decision === 'MOVE_STOP' ||
    output.decision === 'CHANGE_TP'
  ) {
    decisionEvaluation = evaluateManagementDecision({
      decision: output.decision,
      side: output.side,
      anchorMarkPrice: outcome.anchorMarkPrice ?? 0,
      pricePath,
    });
  } else if (output.decision === 'NO_TRADE') {
    decisionEvaluation = {
      available: true,
      performanceScored: false,
      opportunityByHorizon: Object.fromEntries(
        Object.entries(horizons).map(([key, value]) => [key, value.opportunityBps]),
      ),
      note: 'NO_TRADE has no arbitrary scalar penalty.',
    };
  } else {
    decisionEvaluation = {
      available: true,
      performanceScored: false,
      note: 'DATA_BLOCKED is counted but not performance-scored.',
    };
  }

  const score = {
    evaluatorVersion: EVALUATION_V2_VERSION,
    scoreStatus: 'FINAL',
    scoringBasis: 'RELAY_MARK_PRICE_PATH',
    decisionClass: decisionClass(output.decision),
    side: output.side,
    horizons,
    decisionEvaluation,
    notes: [
      'ENTER direction is scored separately from WAIT/NO_TRADE opportunity and management path quality.',
      'TP/SL and trigger timing use sampled relay mark-price path, not tick-perfect exchange events.',
      'No scalar strategy score is assigned in eval-v2.',
    ],
  };
  const thirty = horizons['30m'];
  const isAbstention =
    output.decision === 'WAIT_TRIGGER' || output.decision === 'NO_TRADE';
  return {
    scorePayload: JSON.stringify(score),
    signedReturnBps30m:
      output.decision === 'ENTER_NOW' ? thirty.signedReturnBps : null,
    directionCorrect30m:
      output.decision === 'ENTER_NOW' && thirty.directionCorrect !== null
        ? thirty.directionCorrect
          ? 1
          : 0
        : null,
    opportunityBps30m: isAbstention ? thirty.opportunityBps : null,
  };
}

'''
if 'function scoreRunV2FromOutcome' not in text:
    if score_anchor not in text:
        raise SystemExit('missing scoreRun anchor')
    text = text.replace(score_anchor, score_helper + score_anchor, 1)
branch_anchor = """  if (!outcome || outcome.finalizedAt === null) {
    throw new Error('REPLAY_OUTCOME_NOT_FINALIZED');
  }

  const horizons = {"""
branch_new = """  if (!outcome || outcome.finalizedAt === null) {
    throw new Error('REPLAY_OUTCOME_NOT_FINALIZED');
  }
  if (run.evaluatorVersion === EVALUATION_V2_VERSION)
    return scoreRunV2FromOutcome(outcome, output);

  const horizons = {"""
if branch_anchor not in text:
    raise SystemExit('missing scoreRun finalized anchor')
text = text.replace(branch_anchor, branch_new, 1)
p.write_text(text, encoding='utf-8')

# SQLite-backed tests apply migration 0012 after 0008.
for path in ['tests/unit/worker.phase16-replay.test.ts', 'tests/unit/worker.phase16-eval.test.ts']:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    anchor = """    database.exec(
      readFileSync('worker/migrations/0008_replay_eval_lab.sql', 'utf8'),
    );"""
    if anchor in text and '0012_evaluation_v2.sql' not in text:
        text = text.replace(
            anchor,
            anchor + """
    database.exec(
      readFileSync('worker/migrations/0012_evaluation_v2.sql', 'utf8'),
    );""",
            1,
        )
    p.write_text(text, encoding='utf-8')

# OpenAPI telemetry schema.
p = Path('worker/openapi/openapi.json')
doc = json.loads(p.read_text(encoding='utf-8'))
doc['info']['version'] = '5.5.0'
schemas = doc['components']['schemas']
schemas['StructuredTriggerContract'] = {
    'type': 'object',
    'additionalProperties': False,
    'required': [
        'authoredBy', 'triggerId', 'decisionId', 'sourceSnapshotId',
        'triggerType', 'referencePrice', 'triggerCondition', 'triggerPrice',
        'confirmWindowSec', 'invalidationCondition', 'invalidationPrice',
        'expiresAt', 'maxChaseBps',
    ],
    'properties': {
        'authoredBy': {'type': 'string', 'const': 'GPT'},
        'triggerId': {'type': 'string'},
        'decisionId': {'type': 'string'},
        'sourceSnapshotId': {'type': 'string'},
        'triggerType': {'type': 'string', 'enum': ['PRICE_CROSS', 'PRICE_RECLAIM', 'BREAKOUT_CONFIRM', 'PULLBACK_HOLD']},
        'referencePrice': {'type': 'string', 'const': 'MARK_PRICE'},
        'triggerCondition': {'type': 'string', 'enum': ['AT_OR_ABOVE', 'AT_OR_BELOW']},
        'triggerPrice': {'type': 'number', 'exclusiveMinimum': 0},
        'confirmWindowSec': {'type': 'integer', 'minimum': 0, 'maximum': 300},
        'invalidationCondition': {'type': 'string', 'enum': ['AT_OR_ABOVE', 'AT_OR_BELOW']},
        'invalidationPrice': {'type': 'number', 'exclusiveMinimum': 0},
        'expiresAt': {'type': 'integer', 'minimum': 1},
        'maxChaseBps': {'type': 'number', 'minimum': 0, 'maximum': 1000},
    },
}
schemas['DecisionRecord']['properties']['triggerContract'] = {
    'oneOf': [
        {'$ref': '#/components/schemas/StructuredTriggerContract'},
        {'type': 'null'},
    ],
    'description': 'For WAIT_TRIGGER, the exact GPT-authored mechanical trigger contract shown to the user and eligible for explicit app approval. Omit or null for other decisions.',
}
p.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

# Instructions: telemetry saves the exact trigger contract.
p = Path('worker/openapi/GPT_INSTRUCTIONS.md')
text = p.read_text(encoding='utf-8')
old = "- trigger/invalidation은 짧은 객관 조건, reason/counterThesis는 짧은 tag만. chain-of-thought/전체대화/PII/API secret/account·order ID/raw private response 금지."
new = "- WAIT_TRIGGER이면 사용자에게 제시한 동일 `triggerContract`를 recordDecision에도 그대로 넣는다. trigger/invalidation 요약은 짧게, reason/counterThesis는 tag만 남긴다. chain-of-thought/전체대화/PII/API secret/account·order ID/raw private response 금지."
if old not in text:
    raise SystemExit('missing GPT telemetry instruction anchor')
p.write_text(text.replace(old, new, 1), encoding='utf-8')
