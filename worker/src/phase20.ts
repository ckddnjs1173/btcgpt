import type { Env } from './index';
import { handler as phase16bHandler } from './phase16b';
import { getCrossMarketContext } from './phase17-cross-market';
import { saveReplaySnapshotLease } from './phase16-replay';
import {
  attachDecisionContextPack,
  buildContextPack,
} from './phase20-context-router';

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

async function enrichedSnapshot(
  request: Request,
  env: Env,
): Promise<Response> {
  const response = await phase16bHandler(request, env);
  if (!response.ok) return response;
  try {
    const snapshot = (await response.clone().json()) as Record<string, unknown>;
    const crossMarket = await getCrossMarketContext(env);
    const intelligenceContext = await buildContextPack(
      env,
      snapshot,
      crossMarket,
    );
    const enriched = { ...snapshot, intelligenceContext };
    try {
      await saveReplaySnapshotLease(env, enriched);
    } catch {
      // Replay enrichment is analytics-only and must not block live reads.
    }
    return json(enriched, response.status);
  } catch {
    return response;
  }
}

async function readDecisionId(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { decisionId?: unknown };
    return typeof body.decisionId === 'string' ? body.decisionId : null;
  } catch {
    return null;
  }
}

async function recordedDecision(
  request: Request,
  env: Env,
): Promise<Response> {
  const bodyCopy = request.clone();
  const response = await phase16bHandler(request, env);
  if (!response.ok) return response;
  const decisionId = await readDecisionId(bodyCopy);
  if (!decisionId) return response;
  const contextPackCaptured = await attachDecisionContextPack(env, decisionId);
  try {
    const payload = (await response.clone().json()) as Record<string, unknown>;
    return json({ ...payload, contextPackCaptured }, response.status);
  } catch {
    return response;
  }
}

export async function handler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/v1/snapshot/latest') {
    return enrichedSnapshot(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/decision/record') {
    return recordedDecision(request, env);
  }
  return phase16bHandler(request, env);
}

export default { fetch: handler };
