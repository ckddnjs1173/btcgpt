import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

interface OpenApiDocument {
  servers: Array<{ url: string }>;
  paths: {
    '/v1/snapshot/latest': {
      get: {
        operationId: string;
        'x-openai-isConsequential': boolean;
      };
      put?: unknown;
    };
    '/v1/plan/validate': {
      post: {
        operationId: string;
        'x-openai-isConsequential': boolean;
      };
    };
  };
  components: {
    schemas: {
      TradePlan: {
        required: string[];
      };
    };
  };
}

describe('worker OpenAPI', () => {
  it('exists and contains required operations', () => {
    const p = path.join(process.cwd(), 'worker', 'openapi', 'openapi.json');
    const raw = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(raw) as OpenApiDocument;
    expect(json.servers).toEqual([
      {
        url: 'https://btc-futures-assistant-relay.btcgpt-ck1173.workers.dev',
      },
    ]);
    expect(raw).not.toContain('REPLACE_WITH_WORKER');
    expect(json.paths['/v1/snapshot/latest'].get.operationId).toBe(
      'getLatestSnapshot',
    );
    expect(json.paths['/v1/plan/validate'].post.operationId).toBe(
      'validateTradePlan',
    );
    expect(
      json.paths['/v1/snapshot/latest'].get['x-openai-isConsequential'],
    ).toBe(false);
    expect(
      json.paths['/v1/plan/validate'].post['x-openai-isConsequential'],
    ).toBe(false);
    expect(json.components.schemas.TradePlan.required).toContain('targets');
    expect(json.components.schemas.TradePlan.required).not.toContain(
      'quantity',
    );
    expect(json.paths['/v1/snapshot/latest'].put).toBeUndefined();
  });
});
