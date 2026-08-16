import { z } from 'zod';

import type { Env } from './index';
import { REPLAY_CASE_VERSION } from './phase16-replay';
import {
  EVALUATION_V2_VERSION,
  evaluateEnterPlan,
  evaluateManagementDecision,
  evaluateWaitTrigger,
  parsePricePathJson,
} from './evaluation-v2';
import { structuredTriggerInputSchema } from '../../src/shared/trading/structured-trigger';

export const EVALUATOR_VERSION = EVALUATION_V2_VERSION;
const evaluatorVersionSchema = z.enum(['eval-v1', 'eval-v2']);
const MAX_BODY_BYTES = 20_000;
const MAX_ID_LENGTH = 100;

const experimentSchema = z
  .object({
    experimentId: z.string().trim().min(1).max(MAX_ID_LENGTH),
    name: z.string().trim().min(1).max(160),
    replayVersion: z.literal(REPLAY_CASE_VERSION).default(REPLAY_CASE_VERSION),
    evaluatorVersion: evaluatorVersionSchema.default(EVALUATOR_VERSION),
    provider: z.enum(['OPENAI', 'CUSTOM_GPT', 'MANUAL', 'OTHER']),
    model: z.string().trim().min(1).max(120),
    modelVersion: z.string().trim().min(1).max(120).nullable().optional(),
    instructionVersion: z.string().trim().min(1).max(120),
    contextPackVersion: z.string().trim().min(1).max(120),
    analysisMode: z.enum(['FAST', 'VERIFY', 'DEEP']),
    enabledSources: z
      .array(z.string().trim().min(1).max(80))
      .max(40)
      .default([]),
  })
  .strict();

const runStartSchema = z
  .object({
    runId: z.string().trim().min(1).max(MAX_ID_LENGTH),
    experimentId: z.string().trim().min(1).max(MAX_ID_LENGTH),
    decisionId: z.string().trim().min(1).max(MAX_ID_LENGTH),
    trialIndex: z.number().int().min(1).max(50).default(1),
  })
  .strict();

const outputSchema = z
  .object({
    outputVersion: z
      .enum(['eval-output-v1', 'eval-output-v2'])
      .default('eval-output-v2'),
    decision: z.enum([
      'ENTER_NOW',
      'WAIT_TRIGGER',
      'NO_TRADE',
      'HOLD',
      'PARTIAL_EXIT',
      'EXIT',
      'MOVE_STOP',
      'CHANGE_TP',
      'DATA_BLOCKED',
    ]),
    side: z.enum(['LONG', 'SHORT', 'NEUTRAL']),
    confidenceBand: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']).default('NONE'),
    planValidation: z
      .enum(['NOT_APPLICABLE', 'NOT_RUN', 'VALIDATED', 'BLOCKED'])
      .default('NOT_APPLICABLE'),
    entry: z.number().positive().nullable().optional(),
    stop: z.number().positive().nullable().optional(),
    targets: z.array(z.number().positive()).max(3).default([]),
    triggerSummary: z.string().trim().max(300).nullable().optional(),
    triggerContract: structuredTriggerInputSchema.nullable().optional(),
    invalidationSummary: z.string().trim().max(300).nullable().optional(),
    reasonTags: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
    counterThesisTags: z
      .array(z.string().trim().min(1).max(60))
      .max(8)
      .default([]),
    providerResponseId: z.string().trim().min(1).max(160).nullable().optional(),
    latencyMs: z.number().int().min(0).max(3_600_000).nullable().optional(),
    usage: z
      .object({
        inputTokens: z.number().int().min(0).nullable().optional(),
        outputTokens: z.number().int().min(0).nullable().optional(),
        cachedInputTokens: z.number().int().min(0).nullable().optional(),
        reportedCostUsd: z.number().min(0).nullable().optional(),
        costBasis: z
          .enum(['REPORTED', 'COMPUTED_FROM_PRICING', 'UNKNOWN'])
          .default('UNKNOWN'),
      })
      .strict()
      .default({ costBasis: 'UNKNOWN' }),
  })
  .strict()
  .superRefine((output, context) => {
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
    if (output.decision !== 'ENTER_NOW') return;
    if (output.side === 'NEUTRAL') {
      context.addIssue({
        code: 'custom',
        path: ['side'],
        message: 'ENTER_NOW requires LONG or SHORT side',
      });
    }
    if (
      output.entry === null ||
      output.entry === undefined ||
      output.stop === null ||
      output.stop === undefined ||
      output.targets.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['entry'],
        message: 'ENTER_NOW requires entry, stop and at least one target',
      });
    }
  });

type ExperimentInput = z.infer<typeof experimentSchema>;
type EvalOutput = z.infer<typeof outputSchema>;
type HorizonKey = '1m' | '3m' | '5m' | '15m' | '30m' | '60m';

type ExperimentRow = {
  experimentId: string;
  replayVersion: string;
  evaluatorVersion: string;
  configSha256: string;
  configPayload: string;
};

type ReplayCaseRow = {
  replayVersion: string;
  replayInputSha256: string;
  finalizedAt: number | null;
};

type RunRow = {
  runId: string;
  experimentId: string;
  decisionId: string;
  trialIndex: number;
  replayInputSha256: string;
  startedAt: number;
  outputRecordedAt: number | null;
  completedAt: number | null;
  status: string;
  outputPayloadSha256: string | null;
  outputPayload: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reportedCostUsd: number | null;
  costBasis: string;
  evaluatorVersion: string;
  scoreStatus: string;
  scorePayload: string | null;
  signedReturnBps30m: number | null;
  directionCorrect30m: number | null;
  opportunityBps30m: number | null;
};

type OutcomeRow = {
  finalizedAt: number | null;
  anchorMarkPrice: number | null;
  marketGeneratedAt: number;
  maxUpBps1m: number | null;
  maxDownBps1m: number | null;
  returnBps1m: number | null;
  maxUpBps3m: number | null;
  maxDownBps3m: number | null;
  returnBps3m: number | null;
  maxUpBps5m: number | null;
  maxDownBps5m: number | null;
  returnBps5m: number | null;
  maxUpBps15m: number | null;
  maxDownBps15m: number | null;
  returnBps15m: number | null;
  maxUpBps30m: number | null;
  maxDownBps30m: number | null;
  returnBps30m: number | null;
  maxUpBps60m: number | null;
  maxDownBps60m: number | null;
  returnBps60m: number | null;
  pricePathJson: string;
};

type SummaryRow = {
  totalRuns: number;
  outputRecordedRuns: number;
  finalScoredRuns: number;
  directional30mSamples: number;
  directional30mCorrect: number;
  avgSignedReturnBps30m: number | null;
  abstain30mSamples: number;
  avgOpportunityBps30m: number | null;
  avgLatencyMs: number | null;
  reportedCostSamples: number;
  totalReportedCostUsd: number | null;
};

type HorizonScore = {
  available: boolean;
  rawReturnBps: number | null;
  signedReturnBps: number | null;
  favorableBps: number | null;
  adverseBps: number | null;
  directionCorrect: boolean | null;
  opportunityBps: number | null;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function bearer(request: Request): string | null {
  const value = request.headers.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}

function authorized(request: Request, expected: string): boolean {
  const actual = bearer(request);
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function database(env: Env) {
  if (!env.DB) throw new Error('D1_UNAVAILABLE');
  return env.DB;
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (part) =>
    part.toString(16).padStart(2, '0'),
  ).join('');
}

function safeParse(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function parseJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
  const raw = await request.text();
  if (bytes(raw) > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('INVALID_JSON');
  }
}

function normalizedExperiment(input: ExperimentInput): ExperimentInput {
  return {
    ...input,
    modelVersion: input.modelVersion ?? null,
    enabledSources: [...new Set(input.enabledSources)].sort(),
  };
}

async function loadExperiment(
  env: Env,
  experimentId: string,
): Promise<ExperimentRow | null> {
  return database(env)
    .prepare(
      `SELECT experiment_id AS experimentId,
        replay_version AS replayVersion,
        evaluator_version AS evaluatorVersion,
        config_sha256 AS configSha256,
        config_payload AS configPayload
       FROM replay_experiments WHERE experiment_id = ?`,
    )
    .bind(experimentId)
    .first<ExperimentRow>();
}

async function registerExperiment(
  request: Request,
  env: Env,
): Promise<Response> {
  let input: unknown;
  try {
    input = await parseJsonBody(request);
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }
  const parsed = experimentSchema.safeParse(input);
  if (!parsed.success) {
    return json(
      {
        error: 'INVALID_EXPERIMENT',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400,
    );
  }

  const experiment = normalizedExperiment(parsed.data);
  const configPayload = JSON.stringify(experiment);
  const configSha256 = await sha256(configPayload);
  const existing = await loadExperiment(env, experiment.experimentId);
  if (existing) {
    if (
      existing.configSha256 !== configSha256 ||
      existing.configPayload !== configPayload
    ) {
      return json({ error: 'EXPERIMENT_ID_CONFLICT' }, 409);
    }
    return json({
      ok: true,
      experimentId: experiment.experimentId,
      duplicate: true,
      configSha256,
    });
  }

  const createdAt = Date.now();
  const result = await database(env)
    .prepare(
      `INSERT INTO replay_experiments (
        experiment_id, name, created_at, status, replay_version,
        evaluator_version, provider, model, model_version,
        instruction_version, context_pack_version, analysis_mode,
        enabled_sources_json, config_sha256, config_payload
      ) VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      experiment.experimentId,
      experiment.name,
      createdAt,
      experiment.replayVersion,
      experiment.evaluatorVersion,
      experiment.provider,
      experiment.model,
      experiment.modelVersion ?? null,
      experiment.instructionVersion,
      experiment.contextPackVersion,
      experiment.analysisMode,
      JSON.stringify(experiment.enabledSources),
      configSha256,
      configPayload,
    )
    .run();
  if (!result.success) throw new Error('D1_EXPERIMENT_WRITE_FAILED');

  return json(
    {
      ok: true,
      experimentId: experiment.experimentId,
      duplicate: false,
      createdAt,
      configSha256,
    },
    201,
  );
}

async function loadReplayCase(
  env: Env,
  decisionId: string,
): Promise<ReplayCaseRow | null> {
  return database(env)
    .prepare(
      `SELECT r.replay_version AS replayVersion,
        r.payload_sha256 AS replayInputSha256,
        o.finalized_at AS finalizedAt
       FROM replay_cases r
       LEFT JOIN replay_case_outcomes o ON o.decision_id = r.decision_id
       WHERE r.decision_id = ?`,
    )
    .bind(decisionId)
    .first<ReplayCaseRow>();
}

async function loadRun(env: Env, runId: string): Promise<RunRow | null> {
  return database(env)
    .prepare(
      `SELECT run_id AS runId, experiment_id AS experimentId,
        decision_id AS decisionId, trial_index AS trialIndex,
        replay_input_sha256 AS replayInputSha256, started_at AS startedAt,
        output_recorded_at AS outputRecordedAt, completed_at AS completedAt,
        status, output_payload_sha256 AS outputPayloadSha256,
        output_payload AS outputPayload, latency_ms AS latencyMs,
        input_tokens AS inputTokens, output_tokens AS outputTokens,
        cached_input_tokens AS cachedInputTokens,
        reported_cost_usd AS reportedCostUsd, cost_basis AS costBasis,
        evaluator_version AS evaluatorVersion, score_status AS scoreStatus,
        score_payload AS scorePayload,
        signed_return_bps_30m AS signedReturnBps30m,
        direction_correct_30m AS directionCorrect30m,
        opportunity_bps_30m AS opportunityBps30m
       FROM replay_eval_runs WHERE run_id = ?`,
    )
    .bind(runId)
    .first<RunRow>();
}

async function loadRunByTrial(
  env: Env,
  experimentId: string,
  decisionId: string,
  trialIndex: number,
): Promise<{ runId: string } | null> {
  return database(env)
    .prepare(
      `SELECT run_id AS runId FROM replay_eval_runs
       WHERE experiment_id = ? AND decision_id = ? AND trial_index = ?`,
    )
    .bind(experimentId, decisionId, trialIndex)
    .first<{ runId: string }>();
}

async function startRun(request: Request, env: Env): Promise<Response> {
  let input: unknown;
  try {
    input = await parseJsonBody(request);
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }
  const parsed = runStartSchema.safeParse(input);
  if (!parsed.success) {
    return json(
      {
        error: 'INVALID_RUN',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400,
    );
  }

  const run = parsed.data;
  const experiment = await loadExperiment(env, run.experimentId);
  if (!experiment) return json({ error: 'EXPERIMENT_NOT_FOUND' }, 404);
  const replay = await loadReplayCase(env, run.decisionId);
  if (!replay) return json({ error: 'REPLAY_CASE_NOT_FOUND' }, 404);
  if (replay.replayVersion !== experiment.replayVersion) {
    return json({ error: 'REPLAY_VERSION_MISMATCH' }, 409);
  }
  if (replay.finalizedAt === null) {
    return json({ error: 'REPLAY_OUTCOME_NOT_FINALIZED' }, 409);
  }

  const existing = await loadRun(env, run.runId);
  if (existing) {
    const same =
      existing.experimentId === run.experimentId &&
      existing.decisionId === run.decisionId &&
      existing.trialIndex === run.trialIndex &&
      existing.replayInputSha256 === replay.replayInputSha256;
    if (!same) return json({ error: 'RUN_ID_CONFLICT' }, 409);
    return json({
      ok: true,
      runId: run.runId,
      duplicate: true,
      replayInputSha256: existing.replayInputSha256,
      startedAt: existing.startedAt,
      status: existing.status,
    });
  }

  const trial = await loadRunByTrial(
    env,
    run.experimentId,
    run.decisionId,
    run.trialIndex,
  );
  if (trial) {
    return json(
      { error: 'EXPERIMENT_TRIAL_ALREADY_EXISTS', runId: trial.runId },
      409,
    );
  }

  const startedAt = Date.now();
  const result = await database(env)
    .prepare(
      `INSERT INTO replay_eval_runs (
        run_id, experiment_id, decision_id, trial_index,
        replay_input_sha256, started_at, status, evaluator_version,
        score_status
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, 'PENDING')`,
    )
    .bind(
      run.runId,
      run.experimentId,
      run.decisionId,
      run.trialIndex,
      replay.replayInputSha256,
      startedAt,
      experiment.evaluatorVersion,
    )
    .run();
  if (!result.success) throw new Error('D1_RUN_WRITE_FAILED');

  return json(
    {
      ok: true,
      runId: run.runId,
      duplicate: false,
      replayInputSha256: replay.replayInputSha256,
      startedAt,
      status: 'PENDING',
    },
    201,
  );
}

async function loadOutcome(
  env: Env,
  decisionId: string,
): Promise<OutcomeRow | null> {
  return database(env)
    .prepare(
      `SELECT finalized_at AS finalizedAt,
        market_generated_at AS marketGeneratedAt,
        anchor_mark_price AS anchorMarkPrice,
        max_up_bps_1m AS maxUpBps1m,
        max_down_bps_1m AS maxDownBps1m,
        return_bps_1m AS returnBps1m,
        max_up_bps_3m AS maxUpBps3m,
        max_down_bps_3m AS maxDownBps3m,
        return_bps_3m AS returnBps3m,
        max_up_bps_5m AS maxUpBps5m,
        max_down_bps_5m AS maxDownBps5m,
        return_bps_5m AS returnBps5m,
        max_up_bps_15m AS maxUpBps15m,
        max_down_bps_15m AS maxDownBps15m,
        return_bps_15m AS returnBps15m,
        max_up_bps_30m AS maxUpBps30m,
        max_down_bps_30m AS maxDownBps30m,
        return_bps_30m AS returnBps30m,
        max_up_bps_60m AS maxUpBps60m,
        max_down_bps_60m AS maxDownBps60m,
        return_bps_60m AS returnBps60m,
        price_path_json AS pricePathJson
       FROM replay_case_outcomes WHERE decision_id = ?`,
    )
    .bind(decisionId)
    .first<OutcomeRow>();
}

function horizonValues(
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
  if (horizon === '5m') {
    return {
      rawReturn: outcome.returnBps5m,
      maxUp: outcome.maxUpBps5m,
      maxDown: outcome.maxDownBps5m,
    };
  }
  if (horizon === '15m') {
    return {
      rawReturn: outcome.returnBps15m,
      maxUp: outcome.maxUpBps15m,
      maxDown: outcome.maxDownBps15m,
    };
  }
  if (horizon === '30m') {
    return {
      rawReturn: outcome.returnBps30m,
      maxUp: outcome.maxUpBps30m,
      maxDown: outcome.maxDownBps30m,
    };
  }
  return {
    rawReturn: outcome.returnBps60m,
    maxUp: outcome.maxUpBps60m,
    maxDown: outcome.maxDownBps60m,
  };
}

function maxAbsolute(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return Math.max(...present.map((value) => Math.abs(value)));
}

function scoreHorizon(
  side: EvalOutput['side'],
  values: ReturnType<typeof horizonValues>,
): HorizonScore {
  const { rawReturn, maxUp, maxDown } = values;
  const available = rawReturn !== null;
  if (side === 'NEUTRAL') {
    return {
      available,
      rawReturnBps: rawReturn,
      signedReturnBps: null,
      favorableBps: null,
      adverseBps: null,
      directionCorrect: null,
      opportunityBps: maxAbsolute(maxUp, maxDown),
    };
  }

  const signedReturn =
    rawReturn === null ? null : side === 'LONG' ? rawReturn : -rawReturn;
  const favorable =
    side === 'LONG'
      ? maxUp === null
        ? null
        : Math.max(0, maxUp)
      : maxDown === null
        ? null
        : Math.max(0, -maxDown);
  const adverse =
    side === 'LONG'
      ? maxDown === null
        ? null
        : Math.max(0, -maxDown)
      : maxUp === null
        ? null
        : Math.max(0, maxUp);

  return {
    available,
    rawReturnBps: rawReturn,
    signedReturnBps: signedReturn,
    favorableBps: favorable,
    adverseBps: adverse,
    directionCorrect: signedReturn === null ? null : signedReturn > 0,
    opportunityBps: null,
  };
}

function decisionClass(decision: EvalOutput['decision']): string {
  if (decision === 'ENTER_NOW') return 'ENTER';
  if (decision === 'WAIT_TRIGGER') return 'WAIT';
  if (decision === 'NO_TRADE') return 'ABSTAIN';
  if (decision === 'DATA_BLOCKED') return 'DATA_BLOCKED';
  return 'POSITION_MANAGEMENT';
}

function allHorizonScores(outcome: OutcomeRow, side: EvalOutput['side']) {
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
  const directionalSide =
    output.decision === 'ENTER_NOW' ? output.side : 'NEUTRAL';
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
      anchorMarkPrice:
        outcome.anchorMarkPrice ?? output.triggerContract.triggerPrice,
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
        Object.entries(horizons).map(([key, value]) => [
          key,
          value.opportunityBps,
        ]),
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

async function scoreRun(
  env: Env,
  run: RunRow,
  output: EvalOutput,
): Promise<{
  scorePayload: string;
  signedReturnBps30m: number | null;
  directionCorrect30m: number | null;
  opportunityBps30m: number | null;
}> {
  const outcome = await loadOutcome(env, run.decisionId);
  if (!outcome || outcome.finalizedAt === null) {
    throw new Error('REPLAY_OUTCOME_NOT_FINALIZED');
  }
  if (run.evaluatorVersion === EVALUATION_V2_VERSION)
    return scoreRunV2FromOutcome(outcome, output);

  const horizons = {
    '5m': scoreHorizon(output.side, horizonValues(outcome, '5m')),
    '15m': scoreHorizon(output.side, horizonValues(outcome, '15m')),
    '30m': scoreHorizon(output.side, horizonValues(outcome, '30m')),
    '60m': scoreHorizon(output.side, horizonValues(outcome, '60m')),
  } satisfies Record<Exclude<HorizonKey, '1m' | '3m'>, HorizonScore>;

  const score = {
    evaluatorVersion: run.evaluatorVersion,
    scoreStatus: 'FINAL',
    scoringBasis: 'RELAY_MARK_PRICE',
    decisionClass: decisionClass(output.decision),
    side: output.side,
    horizons,
    notes: [
      'Direction metrics are evaluation vectors, not a local LONG/SHORT signal.',
      'Excursions are relay-sampled and are not tick-perfect exchange extrema.',
      'No scalar strategy score is assigned in eval-v1.',
    ],
  };
  const thirty = horizons['30m'];
  return {
    scorePayload: JSON.stringify(score),
    signedReturnBps30m: thirty.signedReturnBps,
    directionCorrect30m:
      thirty.directionCorrect === null ? null : thirty.directionCorrect ? 1 : 0,
    opportunityBps30m: thirty.opportunityBps,
  };
}

async function persistScore(
  env: Env,
  run: RunRow,
  output: EvalOutput,
): Promise<unknown> {
  const score = await scoreRun(env, run, output);
  const completedAt = Date.now();
  const result = await database(env)
    .prepare(
      `UPDATE replay_eval_runs SET
        completed_at=?, status='SCORED', score_status='FINAL', score_payload=?,
        signed_return_bps_30m=?, direction_correct_30m=?, opportunity_bps_30m=?
       WHERE run_id=? AND output_payload IS NOT NULL`,
    )
    .bind(
      completedAt,
      score.scorePayload,
      score.signedReturnBps30m,
      score.directionCorrect30m,
      score.opportunityBps30m,
      run.runId,
    )
    .run();
  if (!result.success) throw new Error('D1_SCORE_WRITE_FAILED');
  return safeParse(score.scorePayload);
}

async function recordOutput(
  request: Request,
  env: Env,
  runId: string,
): Promise<Response> {
  let input: unknown;
  try {
    input = await parseJsonBody(request);
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }
  const parsed = outputSchema.safeParse(input);
  if (!parsed.success) {
    return json(
      {
        error: 'INVALID_EVAL_OUTPUT',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400,
    );
  }

  const run = await loadRun(env, runId);
  if (!run) return json({ error: 'RUN_NOT_FOUND' }, 404);
  const replay = await loadReplayCase(env, run.decisionId);
  if (!replay) return json({ error: 'REPLAY_CASE_NOT_FOUND' }, 404);
  if (replay.replayInputSha256 !== run.replayInputSha256) {
    return json({ error: 'REPLAY_INPUT_HASH_MISMATCH' }, 409);
  }

  const output = parsed.data;
  const outputPayload = JSON.stringify(output);
  const outputPayloadSha256 = await sha256(outputPayload);
  if (run.outputPayloadSha256 !== null) {
    if (
      run.outputPayloadSha256 !== outputPayloadSha256 ||
      run.outputPayload !== outputPayload
    ) {
      return json({ error: 'RUN_OUTPUT_CONFLICT' }, 409);
    }
    const score =
      run.scoreStatus === 'FINAL' && run.scorePayload !== null
        ? safeParse(run.scorePayload)
        : await persistScore(env, run, output);
    return json({
      ok: true,
      runId,
      duplicate: true,
      status: 'SCORED',
      score,
    });
  }

  const recordedAt = Date.now();
  const usage = output.usage;
  const write = await database(env)
    .prepare(
      `UPDATE replay_eval_runs SET
        output_recorded_at=?, status='OUTPUT_RECORDED',
        output_payload_sha256=?, output_payload=?, latency_ms=?,
        input_tokens=?, output_tokens=?, cached_input_tokens=?,
        reported_cost_usd=?, cost_basis=?
       WHERE run_id=? AND output_payload IS NULL`,
    )
    .bind(
      recordedAt,
      outputPayloadSha256,
      outputPayload,
      output.latencyMs ?? null,
      usage.inputTokens ?? null,
      usage.outputTokens ?? null,
      usage.cachedInputTokens ?? null,
      usage.reportedCostUsd ?? null,
      usage.costBasis,
      runId,
    )
    .run();
  if (!write.success) throw new Error('D1_OUTPUT_WRITE_FAILED');

  const refreshed = await loadRun(env, runId);
  if (!refreshed) throw new Error('D1_RUN_READ_FAILED');
  const score = await persistScore(env, refreshed, output);
  return json(
    {
      ok: true,
      runId,
      duplicate: false,
      outputRecordedAt: recordedAt,
      status: 'SCORED',
      score,
    },
    201,
  );
}

async function readRun(env: Env, runId: string): Promise<Response> {
  const run = await loadRun(env, runId);
  if (!run) return json({ error: 'RUN_NOT_FOUND' }, 404);
  return json({
    runId: run.runId,
    experimentId: run.experimentId,
    decisionId: run.decisionId,
    trialIndex: run.trialIndex,
    replayInputSha256: run.replayInputSha256,
    startedAt: run.startedAt,
    outputRecordedAt: run.outputRecordedAt,
    completedAt: run.completedAt,
    status: run.status,
    evaluatorVersion: run.evaluatorVersion,
    output: safeParse(run.outputPayload),
    usage: {
      latencyMs: run.latencyMs,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cachedInputTokens: run.cachedInputTokens,
      reportedCostUsd: run.reportedCostUsd,
      costBasis: run.costBasis,
    },
    scoreStatus: run.scoreStatus,
    score: safeParse(run.scorePayload),
  });
}

async function experimentSummary(
  env: Env,
  experimentId: string,
): Promise<Response> {
  const experiment = await loadExperiment(env, experimentId);
  if (!experiment) return json({ error: 'EXPERIMENT_NOT_FOUND' }, 404);
  const summary = await database(env)
    .prepare(
      `SELECT
        COUNT(*) AS totalRuns,
        SUM(CASE WHEN output_payload IS NOT NULL THEN 1 ELSE 0 END) AS outputRecordedRuns,
        SUM(CASE WHEN score_status = 'FINAL' THEN 1 ELSE 0 END) AS finalScoredRuns,
        SUM(CASE WHEN signed_return_bps_30m IS NOT NULL THEN 1 ELSE 0 END) AS directional30mSamples,
        SUM(CASE WHEN direction_correct_30m = 1 THEN 1 ELSE 0 END) AS directional30mCorrect,
        AVG(signed_return_bps_30m) AS avgSignedReturnBps30m,
        SUM(CASE WHEN opportunity_bps_30m IS NOT NULL THEN 1 ELSE 0 END) AS abstain30mSamples,
        AVG(opportunity_bps_30m) AS avgOpportunityBps30m,
        AVG(latency_ms) AS avgLatencyMs,
        SUM(CASE WHEN reported_cost_usd IS NOT NULL AND cost_basis != 'UNKNOWN' THEN 1 ELSE 0 END) AS reportedCostSamples,
        SUM(CASE WHEN reported_cost_usd IS NOT NULL AND cost_basis != 'UNKNOWN' THEN reported_cost_usd ELSE 0 END) AS totalReportedCostUsd
       FROM replay_eval_runs WHERE experiment_id = ?`,
    )
    .bind(experimentId)
    .first<SummaryRow>();

  const row = summary ?? {
    totalRuns: 0,
    outputRecordedRuns: 0,
    finalScoredRuns: 0,
    directional30mSamples: 0,
    directional30mCorrect: 0,
    avgSignedReturnBps30m: null,
    abstain30mSamples: 0,
    avgOpportunityBps30m: null,
    avgLatencyMs: null,
    reportedCostSamples: 0,
    totalReportedCostUsd: 0,
  };
  return json({
    experimentId,
    configSha256: experiment.configSha256,
    config: safeParse(experiment.configPayload),
    totalRuns: row.totalRuns,
    outputRecordedRuns: row.outputRecordedRuns,
    finalScoredRuns: row.finalScoredRuns,
    directional30m: {
      samples: row.directional30mSamples,
      correct: row.directional30mCorrect,
      accuracy:
        row.directional30mSamples > 0
          ? row.directional30mCorrect / row.directional30mSamples
          : null,
      avgSignedReturnBps: row.avgSignedReturnBps30m,
    },
    abstain30m: {
      samples: row.abstain30mSamples,
      avgOpportunityBps: row.avgOpportunityBps30m,
    },
    efficiency: {
      avgLatencyMs: row.avgLatencyMs,
      reportedCostSamples: row.reportedCostSamples,
      totalReportedCostUsd: row.totalReportedCostUsd ?? 0,
    },
    caution:
      'Directional accuracy is descriptive only and is not the promotion objective. Compare expectancy, path quality, latency and cost together.',
  });
}

function decodedId(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const value = decodeURIComponent(raw);
    return value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null;
  } catch {
    return null;
  }
}

export async function handleReplayEvalRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const isResearchPath = url.pathname.startsWith('/v1/replay/');
  if (!isResearchPath) return null;

  const isExperimentRegister =
    request.method === 'POST' &&
    url.pathname === '/v1/replay/experiment/register';
  const isRunStart =
    request.method === 'POST' && url.pathname === '/v1/replay/run/start';
  const runOutputMatch = url.pathname.match(
    /^\/v1\/replay\/run\/([^/]+)\/output$/,
  );
  const runReadMatch = url.pathname.match(/^\/v1\/replay\/run\/([^/]+)$/);
  const summaryMatch = url.pathname.match(
    /^\/v1\/replay\/experiment\/([^/]+)\/summary$/,
  );

  const handles =
    isExperimentRegister ||
    isRunStart ||
    (request.method === 'POST' && runOutputMatch !== null) ||
    (request.method === 'GET' && runReadMatch !== null) ||
    (request.method === 'GET' && summaryMatch !== null);
  if (!handles) return null;

  if (!authorized(request, env.ACTION_READ_KEY)) {
    return json({ error: 'UNAUTHORIZED' }, 401);
  }

  try {
    if (isExperimentRegister) return await registerExperiment(request, env);
    if (isRunStart) return await startRun(request, env);
    if (runOutputMatch) {
      const runId = decodedId(runOutputMatch[1]);
      if (!runId) return json({ error: 'INVALID_RUN_ID' }, 400);
      return await recordOutput(request, env, runId);
    }
    if (runReadMatch) {
      const runId = decodedId(runReadMatch[1]);
      if (!runId) return json({ error: 'INVALID_RUN_ID' }, 400);
      return await readRun(env, runId);
    }
    if (summaryMatch) {
      const experimentId = decodedId(summaryMatch[1]);
      if (!experimentId) return json({ error: 'INVALID_EXPERIMENT_ID' }, 400);
      return await experimentSummary(env, experimentId);
    }
    return null;
  } catch (error) {
    const message = (error as Error).message;
    if (message === 'REPLAY_OUTCOME_NOT_FINALIZED') {
      return json({ error: message }, 409);
    }
    return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  }
}
