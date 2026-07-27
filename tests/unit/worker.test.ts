import { describe, it, expect } from 'vitest';
import { handler } from '../../worker/src/index';

describe('worker handler', () => {
  it('responds to health', async () => {
    const res = await handler(new Request('https://example.com/health'));
    const json = (await res.json()) as { ok?: boolean };
    expect(json.ok).toBe(true);
  });

  it('PUT and GET snapshot', async () => {
    const put = await handler(new Request('https://example.com/v1/snapshot/latest', { method: 'PUT', body: JSON.stringify({ foo: 'bar' }) }));
    expect(put.status).toBe(200);
    const get = await handler(new Request('https://example.com/v1/snapshot/latest'));
    const text = await get.text();
       expect(text).toContain('"raw":');
       expect(text).toContain('\\"foo\\":\\"bar\\"');
  });
});
