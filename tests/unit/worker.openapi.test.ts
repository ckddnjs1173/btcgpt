import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('worker OpenAPI', () => {
  it('exists and contains required operations', () => {
    const p = path.join(process.cwd(), 'worker', 'openapi', 'openapi.json');
    const raw = fs.readFileSync(p, 'utf8');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const json = JSON.parse(raw);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(json.paths['/v1/snapshot/latest'].get.operationId).toBe('getLatestSnapshot');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(json.paths['/v1/plan/validate'].post.operationId).toBe('validateTradePlan');
  });
});
