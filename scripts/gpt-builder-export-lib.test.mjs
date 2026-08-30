import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  BUILDER_OPERATION_DESCRIPTION_LIMIT,
  EXPECTED_OPERATION_IDS,
  buildBuilderSchema,
  codePointLength,
  listOperations,
  validateBuilderSchema,
  validateInstructions,
} from './gpt-builder-export-lib.mjs';

const instructions = fs.readFileSync(
  'worker/openapi/GPT_INSTRUCTIONS.md',
  'utf8',
);
const sourceOpenApi = JSON.parse(
  fs.readFileSync('worker/openapi/openapi.json', 'utf8'),
);

test('canonical instructions are valid UTF-8 and fit Builder limits', () => {
  const result = validateInstructions(instructions);
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(instructions.includes('\uFFFD'), false);
});

test(
  'Builder projection preserves operations, auth, server, and request/response contract',
  () => {
    const projected = buildBuilderSchema(sourceOpenApi);
    const result = validateBuilderSchema(projected);

    assert.equal(result.ok, true, result.failures.join('\n'));
    assert.deepEqual(
      result.operationIds.sort(),
      [...EXPECTED_OPERATION_IDS].sort(),
    );
    assert.deepEqual(projected.servers, sourceOpenApi.servers);
    assert.deepEqual(
      projected.components.securitySchemes,
      sourceOpenApi.components.securitySchemes,
    );

    for (const [pathName, pathItem] of Object.entries(sourceOpenApi.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!operation || typeof operation !== 'object' || !operation.operationId)
          continue;
        const projectedOperation = projected.paths[pathName][method];
        assert.equal(projectedOperation.operationId, operation.operationId);
        assert.deepEqual(projectedOperation.parameters, operation.parameters);
        assert.deepEqual(projectedOperation.requestBody, operation.requestBody);
        assert.deepEqual(projectedOperation.responses, operation.responses);
        assert.deepEqual(projectedOperation.security, operation.security);
        assert.deepEqual(
          projectedOperation['x-openai-isConsequential'],
          operation['x-openai-isConsequential'],
        );
      }
    }
  },
);

test(
  'Builder projection caps operation descriptions without mutating source schema',
  () => {
    const original = structuredClone(sourceOpenApi);
    const projected = buildBuilderSchema(sourceOpenApi);

    assert.deepEqual(sourceOpenApi, original);
    for (const operation of listOperations(projected)) {
      if (typeof operation.description !== 'string') continue;
      assert.ok(
        codePointLength(operation.description) <=
          BUILDER_OPERATION_DESCRIPTION_LIMIT,
        `${operation.operationId} description is too long`,
      );
    }

    const sourceDecision = listOperations(sourceOpenApi).find(
      (operation) => operation.operationId === 'getDecisionSnapshot',
    );
    const projectedDecision = listOperations(projected).find(
      (operation) => operation.operationId === 'getDecisionSnapshot',
    );
    assert.ok(sourceDecision);
    assert.ok(projectedDecision);
    assert.ok(
      codePointLength(sourceDecision.description) >
        BUILDER_OPERATION_DESCRIPTION_LIMIT,
    );
    assert.equal(
      codePointLength(projectedDecision.description),
      BUILDER_OPERATION_DESCRIPTION_LIMIT,
    );
  },
);
