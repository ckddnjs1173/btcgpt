import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

interface OpenApiDocument {
  info: {
    version: string;
  };
  servers: Array<{ url: string }>;
  paths: {
    '/v1/snapshot/latest': {
      get: {
        operationId: string;
        'x-openai-isConsequential': boolean;
      };
      put?: unknown;
    };
    '/v1/context/latest': {
      get: {
        operationId: string;
        'x-openai-isConsequential': boolean;
      };
    };
    '/v1/plan/validate': {
      post: {
        operationId: string;
        'x-openai-isConsequential': boolean;
      };
    };
    '/v1/trading-state/latest': {
      get: {
        operationId: string;
        'x-openai-isConsequential': boolean;
      };
    };
    '/v1/decision/record': {
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
      DecisionRecord: {
        required: string[];
      };
    };
  };
}

describe('worker OpenAPI', () => {
  it('exists and contains the unified GPT operations', () => {
    const p = path.join(process.cwd(), 'worker', 'openapi', 'openapi.json');
    const raw = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(raw) as OpenApiDocument;

    expect(json.info.version).toBe('5.2.0');
    expect(json.servers).toEqual([
      {
        url: 'https://btc-futures-assistant-relay.btcgpt-ck1173.workers.dev',
      },
    ]);
    expect(raw).not.toContain('REPLACE_WITH_WORKER');

    expect(json.paths['/v1/snapshot/latest'].get.operationId).toBe(
      'getLatestSnapshot',
    );
    expect(json.paths['/v1/context/latest'].get.operationId).toBe(
      'getExternalContext',
    );
    expect(json.paths['/v1/plan/validate'].post.operationId).toBe(
      'validateTradePlan',
    );
    expect(json.paths['/v1/trading-state/latest'].get.operationId).toBe(
      'getTradeLifecycle',
    );
    expect(json.paths['/v1/decision/record'].post.operationId).toBe(
      'recordDecision',
    );

    expect(
      json.paths['/v1/snapshot/latest'].get['x-openai-isConsequential'],
    ).toBe(false);
    expect(
      json.paths['/v1/plan/validate'].post['x-openai-isConsequential'],
    ).toBe(false);
    expect(
      json.paths['/v1/decision/record'].post['x-openai-isConsequential'],
    ).toBe(false);

    expect(json.components.schemas.TradePlan.required).toContain('targets');
    expect(json.components.schemas.TradePlan.required).not.toContain(
      'quantity',
    );
    expect(json.components.schemas.DecisionRecord.required).toContain(
      'snapshotId',
    );
    expect(json.components.schemas.DecisionRecord.required).toContain(
      'decisionId',
    );
    expect(json.paths['/v1/snapshot/latest'].put).toBeUndefined();
  });

  it('keeps the canonical Custom GPT instructions within the editor limit', () => {
    const p = path.join(
      process.cwd(),
      'worker',
      'openapi',
      'GPT_INSTRUCTIONS.md',
    );
    const raw = fs.readFileSync(p, 'utf8');

    expect(Array.from(raw).length).toBeLessThanOrEqual(7_500);
    expect(raw).toContain('instructionVersion=phase23-v1');
    expect(raw).toContain('contextPackVersion=context-v2');
    expect(raw).toContain('reasoningPolicy.recommendedMode');
    expect(raw).toContain('tradingMemory');
    expect(raw).toContain('positionManagement');
    expect(raw).toContain('recordDecision');
  });
});
