type SnapshotStore = { raw: string; receivedAt: number } | null;
let latestSnapshot: SnapshotStore = null;

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === 'GET' && url.pathname === '/health') {
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  if (url.pathname === '/v1/snapshot/latest') {
    if (req.method === 'PUT') {
      const raw = await req.text();
      latestSnapshot = { raw, receivedAt: Date.now() };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (req.method === 'GET') {
      if (!latestSnapshot) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(latestSnapshot), { status: 200 });
    }
  }

  if (url.pathname === '/v1/plan/validate') {
    if (req.method === 'POST') {
      // Minimal validation logic: echo back a neutral success payload
      return new Response(JSON.stringify({ ok: true, errors: [] }), { status: 200 });
    }
  }

  return new Response('Not Found', { status: 404 });
}

export { latestSnapshot };
