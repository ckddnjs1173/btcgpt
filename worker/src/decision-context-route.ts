import { buildDecisionContext } from './decision-context';
import { getCrossMarketContext } from './phase17-cross-market';
import { buildContextPack } from './phase20-context-router';
import { applyRelayFreshness } from './relay-freshness';
import type { Env } from './index';

type SnapshotRow = {
  raw: string;
  generatedAt: number;
  receivedAt: number;
};

const MAX_RESPONSE_BYTES = 90_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function authorized(request: Request, expected: string): boolean {
  if (!expected) return false;
  const bearer = request.headers.get('authorization');
  const direct = request.headers.get('x-action-key');
  return bearer === `Bearer ${expected}` || direct === expected;
}

async function loadSnapshot(env: Env): Promise<SnapshotRow | null> {
  return env.DB.prepare(
    `SELECT payload AS raw, generated_at AS generatedAt,
      received_at AS receivedAt FROM snapshot_latest WHERE id = 1`,
  ).first<SnapshotRow>();
}

export async function handleDecisionContextRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!authorized(request, env.ACTION_READ_KEY))
    return json({ error: 'UNAUTHORIZED' }, 401);

  const actionStartedAt = Date.now();
  let stored: SnapshotRow | null;
  try {
    stored = await loadSnapshot(env);
  } catch {
    return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  }
  if (!stored) return json({ error: 'NOT_FOUND' }, 404);

  let snapshot: Record<string, unknown>;
  try {
    snapshot = applyRelayFreshness(
      JSON.parse(stored.raw) as Record<string, unknown>,
      stored.generatedAt,
      stored.receivedAt,
      actionStartedAt,
    );
  } catch {
    return json({ error: 'INVALID_STORED_SNAPSHOT' }, 503);
  }

  try {
    const crossMarket = await getCrossMarketContext(env, actionStartedAt);
    const contextPack = await buildContextPack(
      env,
      snapshot,
      crossMarket,
      actionStartedAt,
    );
    const responseBody = buildDecisionContext({
      snapshot,
      contextPack,
      relayReceivedAt: stored.receivedAt,
      actionStartedAt,
      generatedAt: Date.now(),
    });
    const bytes = new TextEncoder().encode(JSON.stringify(responseBody)).byteLength;
    if (bytes > MAX_RESPONSE_BYTES)
      return json({ error: 'RESPONSE_TOO_LARGE', bytes }, 500);
    return json(responseBody);
  } catch {
    return json({ error: 'DECISION_CONTEXT_UNAVAILABLE' }, 503);
  }
}
