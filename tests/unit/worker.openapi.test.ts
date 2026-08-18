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
    '/v1/position-adjustment/validate': {
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
          contextGeneratedAt?: { description?: string };
          triggerContract?: unknown;
        };
      };
      DecisionContext: {
        additionalProperties: boolean;
        required: string[];
      };
      PositionAdjustmentRequest: {
        additionalProperties: boolean;
        required: string[];
      };
      PositionAdjustmentResponse: {
        additionalProperties: boolean;
        required: string[];
      };
      StructuredTriggerContract: {
        additionalProperties: boolean;
        required: string[];
      };
      LocalMarketIntelligence: {
        additionalProperties: boolean;
        required: string[];
        properties: { version: { enum: string[] } };
      };
      CrossVenueIntelligence: {
        additionalProperties: boolean;
        required: string[];
      };
      DeribitOptionsV2: {
        additionalProperties: boolean;
        required: string[];
        properties: {
          version: { const: string };
          objectiveOnly: { const: boolean };
        };
      };
      OnchainV1: {
        additionalProperties: boolean;
        required: string[];
        properties: {
          version: { const: string };
          objectiveOnly: { const: boolean };
          role: { const: string };
        };
      };
    };
  };
}

describe('worker OpenAPI', () => {
  it('exists and contains the unified GPT operations', () => {
    const p = path.join(process.cwd(), 'worker', 'openapi', 'openapi.json');
    const raw = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(raw) as OpenApiDocument;

    expect(json.info.version).toBe('5.9.0');
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
    expect(
      json.paths['/v1/position-adjustment/validate'].post.operationId,
    ).toBe('validatePositionAdjustment');
    expect(json.paths['/v1/trading-state/latest'].get.operationId).toBe(
      'getTradeLifecycle',
    );
    expect(json.paths['/v1/decision/record'].post.operationId).toBe(
      'recordDecision',
    );

    expect(
      json.paths['/v1/decision-context/latest'].get['x-openai-isConsequential'],
    ).toBe(false);
    expect(
      json.paths['/v1/position-adjustment/validate'].post[
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
    expect(
      json.paths['/v1/position-adjustment/validate'].post.security,
    ).toEqual([{ actionKey: [] }]);
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
    expect(
      json.components.schemas.PositionAdjustmentRequest.additionalProperties,
    ).toBe(false);
    expect(json.components.schemas.PositionAdjustmentRequest.required).toEqual([
      'snapshotId',
      'action',
    ]);
    expect(
      json.components.schemas.PositionAdjustmentResponse.additionalProperties,
    ).toBe(false);
    expect(json.components.schemas.PositionAdjustmentResponse.required).toEqual(
      ['ok', 'errors'],
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
    expect(
      json.components.schemas.DecisionRecord.properties.contextGeneratedAt
        ?.description,
    ).toContain('Decision Context');
    expect(
      json.components.schemas.DecisionRecord.properties.triggerContract,
    ).toBeDefined();
    expect(
      json.components.schemas.StructuredTriggerContract.additionalProperties,
    ).toBe(false);
    expect(
      json.components.schemas.StructuredTriggerContract.required,
    ).toContain('sourceSnapshotId');
    expect(
      json.components.schemas.LocalMarketIntelligence.properties.version.enum,
    ).toEqual(['local-market-v2']);
    expect(json.components.schemas.LocalMarketIntelligence.required).toContain(
      'crossVenue',
    );
    expect(
      json.components.schemas.CrossVenueIntelligence.additionalProperties,
    ).toBe(false);
    expect(json.components.schemas.CrossVenueIntelligence.required).toContain(
      'interpretationBoundary',
    );
    expect(json.components.schemas.DeribitOptionsV2.additionalProperties).toBe(
      false,
    );
    expect(json.components.schemas.DeribitOptionsV2.required).toContain(
      'skew25Delta',
    );
    expect(
      json.components.schemas.DeribitOptionsV2.properties.version.const,
    ).toBe('deribit-options-v2');
    expect(
      json.components.schemas.DeribitOptionsV2.properties.objectiveOnly.const,
    ).toBe(true);
    expect(json.components.schemas.OnchainV1.additionalProperties).toBe(false);
    expect(json.components.schemas.OnchainV1.required).toContain(
      'networkDaily',
    );
    expect(json.components.schemas.OnchainV1.properties.version.const).toBe(
      'onchain-v1',
    );
    expect(
      json.components.schemas.OnchainV1.properties.objectiveOnly.const,
    ).toBe(true);
    expect(json.components.schemas.OnchainV1.properties.role.const).toBe(
      'BACKGROUND_REGIME_ONLY',
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
    expect(raw).toContain('getDecisionSnapshot');
    expect(raw).toContain('validatePositionAdjustment');
    expect(raw).toContain('triggerContract');
    expect(raw).toContain('TRIGGERED');
    expect(raw).toContain('재분석');
    expect(raw).toContain('instructionVersion=gpt-policy-v3');
    expect(raw).toContain('contextPackVersion=decision-context-v1');
    expect(raw).not.toContain('instructionVersion=gpt-policy-v2');
    expect(raw).not.toContain('instructionVersion=decision-context-v1');
    expect(raw).not.toContain('instructionVersion=phase23-v1');
    expect(raw).not.toContain('contextPackVersion=context-v2');
    expect(raw).toContain('reasoningPolicy.recommendedMode');
    expect(raw).toContain('tradingMemory');
    expect(raw).toContain('positionManagement');
    expect(raw).toContain('recordDecision');
  });
});
