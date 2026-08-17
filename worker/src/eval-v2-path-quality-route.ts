import type { Env } from './index';
import {
  aggregateEvalV2PathQuality,
  type EvalV2ScoreRow,
} from './eval-v2-path-summary';

type D1AllStatement = {
  all<T>(): Promise<{ results?: T[]; success: boolean }>;
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

function decodedId(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const value = decodeURIComponent(raw);
    return value.length > 0 && value.length <= 100 ? value : null;
  } catch {
    return null;
  }
}

async function experimentExists(env: Env, experimentId: string) {
  return database(env)
    .prepare(
      `SELECT experiment_id AS experimentId
       FROM replay_experiments
       WHERE experiment_id = ?`,
    )
    .bind(experimentId)
    .first<{ experimentId: string }>();
}

async function loadScoreRows(
  env: Env,
  experimentId: string,
): Promise<EvalV2ScoreRow[]> {
  const statement = database(env)
    .prepare(
      `SELECT decision_id AS decisionId, score_payload AS scorePayload
       FROM replay_eval_runs
       WHERE experiment_id = ?
         AND status = 'SCORED'
         AND score_status = 'FINAL'
         AND evaluator_version = 'eval-v2'
         AND score_payload IS NOT NULL
       ORDER BY started_at ASC`,
    )
    .bind(experimentId) as unknown as D1AllStatement;
  const result = await statement.all<EvalV2ScoreRow>();
  return result.results ?? [];
}

export async function handleEvalV2PathQualityRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/v1\/research\/path-quality\/([^/]+)$/);
  if (!match) return null;

  if (!authorized(request, env.ACTION_READ_KEY)) {
    return json({ error: 'UNAUTHORIZED' }, 401);
  }

  const experimentId = decodedId(match[1]);
  if (!experimentId) return json({ error: 'INVALID_EXPERIMENT_ID' }, 400);

  try {
    const experiment = await experimentExists(env, experimentId);
    if (!experiment) return json({ error: 'EXPERIMENT_NOT_FOUND' }, 404);
    const rows = await loadScoreRows(env, experimentId);
    return json({
      experimentId,
      ...aggregateEvalV2PathQuality(rows),
    });
  } catch {
    return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  }
}
