import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

interface ActionOperation {
  operationId: string;
  'x-openai-isConsequential': boolean;
  security?: Array<Record<string, unknown[]>>;
}

interface OpenApiDocument {
  info: {
    version: string;
  };
  servers: Array<{ url: string }>;
  security: Array<Record<string, unknown[]>>;
  paths: {
    '/v1/snapshot/latest': {
      get: ActionOperation;
      put?: unknown;
    };
    '/v1/context/latest': {
      get: ActionOperation;
    };
    '/v1/plan/validate': {
      post: ActionOperation;
    };
    '/v1/trading-state/latest': {
      get: ActionOperation;
    };
    '/v1/decision/record': {
      post: ActionOperation;
    };
    '/v1/decision-context/latest': {
      get: ActionOperation;
    };
  };
  components: {
    securitySchemes: Record<
      string,
      {
        type: string;
        scheme: string;
      }
    >;
    schemas: {
      TradePlan: {
        required: string[];
        properties: {
          snapshotId: { description?: string };
        };
      };
      DecisionRecord: {
        required: string[];
        properties: {
          snapshotId: { description?: string };
          marketGeneratedAt: { description?: string };
        };
      };
      DecisionContext: {
        additionalProperties: boolean;
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

    expect(json.info.version).toBe('5.3.0');
    expect(json.servers).toEqual([
      {
        url: 'https://btc-futures-assistant-relay.btcgpt-ck1173.workers.dev',
      },
    ]);
    expect(raw).not.toContain('REPLACE_WITH_WORKER');

    expect(json.paths['/v1/decision-context/latest'].get.operationId).toBe(
      'getDecisionSnapshot',
    );
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
      json.paths['/v1/decision-context/latest'].get[
        'x-openai-isConsequential'
      ],
    ).toBe(false);
    expect(
      json.paths['/v1/snapshot/latest'].get['x-openai-isConsequential'],
    ).toBe(false);
    expect(
      json.paths['/v1/plan/validate'].post['x-openai-isConsequential'],
    ).toBe(false);
    expect(
      json.paths['/v1/decision/record'].post['x-openai-isConsequential'],
    ).toBe(false);

    expect(json.components.securitySchemes.actionKey).toEqual({
      type: 'http',
      scheme: 'bearer',
    });
    expect(json.security).toEqual([{ actionKey: [] }]);
    expect(json.paths['/v1/decision-context/latest'].get.security).toEqual([
      { actionKey: [] },
    ]);
    expect(raw).not.toContain('bearerAuth');

    expect(json.components.schemas.DecisionContext.additionalProperties).toBe(
      false,
    );
    expect(json.components.schemas.DecisionContext.required).toContain(
      'decisionGates',
    );
    expect(json.components.schemas.DecisionContext.required).toContain(
      'cryptoMarket',
    );
    expect(json.components.schemas.DecisionContext.required).toContain(
      'timing',
    );

    expect(json.components.schemas.TradePlan.required).toContain('targets');
    expect(json.components.schemas.TradePlan.required).not.toContain(
      'quantity',
    );
    expect(
      json.components.schemas.TradePlan.properties.snapshotId.description,
    ).toContain('live decision context');
    expect(json.components.schemas.DecisionRecord.required).toContain(
      'snapshotId',
    );
    expect(json.components.schemas.DecisionRecord.required).toContain(
      'decisionId',
    );
    expect(
      json.components.schemas.DecisionRecord.properties.snapshotId.description,
    ).toContain('Decision Context');
    expect(
      json.components.schemas.DecisionRecord.properties.marketGeneratedAt
        .description,
    ).toContain('Decision Context');
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
    expect(raw).toContain('getDecisionSnapshot');
    expect(raw).toContain('instructionVersion=decision-context-v1');
    expect(raw).toContain('contextPackVersion=decision-context-v1');
    expect(raw).not.toContain('instructionVersion=phase23-v1');
    expect(raw).not.toContain('contextPackVersion=context-v2');
    expect(raw).toContain('reasoningPolicy.recommendedMode');
    expect(raw).toContain('tradingMemory');
    expect(raw).toContain('positionManagement');
    expect(raw).toContain('recordDecision');
  });
});
