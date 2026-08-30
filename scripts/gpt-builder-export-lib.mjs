export const INTERNAL_INSTRUCTION_BUDGET = 7_500;
export const BUILDER_INSTRUCTION_LIMIT = 8_000;
export const BUILDER_OPERATION_DESCRIPTION_LIMIT = 300;

export const EXPECTED_OPERATION_IDS = [
  'getDecisionSnapshot',
  'getLatestSnapshot',
  'getExternalContext',
  'validateTradePlan',
  'validatePositionAdjustment',
  'getTradeLifecycle',
  'recordDecision',
];

export function codePointLength(value) {
  return Array.from(value).length;
}

function truncateCodePoints(value, limit) {
  if (codePointLength(value) <= limit) return value;
  if (limit <= 3) return Array.from(value).slice(0, limit).join('');
  return `${Array.from(value).slice(0, limit - 3).join('')}...`;
}

function isOperation(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.operationId === 'string'
  );
}

export function listOperations(openApi) {
  return Object.values(openApi.paths ?? {})
    .flatMap((pathItem) => Object.values(pathItem ?? {}))
    .filter(isOperation);
}

export function buildBuilderSchema(openApi) {
  const projected = structuredClone(openApi);
  for (const operation of listOperations(projected)) {
    if (typeof operation.description === 'string') {
      operation.description = truncateCodePoints(
        operation.description,
        BUILDER_OPERATION_DESCRIPTION_LIMIT,
      );
    }
  }
  return projected;
}

export function validateInstructions(instructions) {
  const failures = [];
  const length = codePointLength(instructions);

  if (length > INTERNAL_INSTRUCTION_BUDGET) {
    failures.push(
      `GPT instructions exceed internal ${INTERNAL_INSTRUCTION_BUDGET}-character budget (${length})`,
    );
  }
  if (length > BUILDER_INSTRUCTION_LIMIT) {
    failures.push(
      `GPT instructions exceed Builder ${BUILDER_INSTRUCTION_LIMIT}-character limit (${length})`,
    );
  }
  if (instructions.includes('\uFFFD')) {
    failures.push('GPT instructions contain Unicode replacement characters');
  }
  if (!instructions.includes('# BTC Futures Assistant — GPT Policy v3')) {
    failures.push('GPT instructions are not GPT Policy v3');
  }

  return { ok: failures.length === 0, failures, length };
}

export function validateBuilderSchema(openApi) {
  const failures = [];
  const operations = listOperations(openApi);
  const operationIds = operations.map((operation) => operation.operationId);

  if (openApi.openapi !== '3.1.0') {
    failures.push(`Builder schema must remain OpenAPI 3.1.0; found ${openApi.openapi}`);
  }

  for (const operationId of EXPECTED_OPERATION_IDS) {
    if (!operationIds.includes(operationId)) {
      failures.push(`Builder schema missing operationId ${operationId}`);
    }
  }

  for (const operationId of operationIds) {
    if (!EXPECTED_OPERATION_IDS.includes(operationId)) {
      failures.push(`Builder schema contains unexpected operationId ${operationId}`);
    }
  }

  if (new Set(operationIds).size !== operationIds.length) {
    failures.push('Builder schema contains duplicate operationId values');
  }

  for (const operation of operations) {
    if (
      typeof operation.description === 'string' &&
      codePointLength(operation.description) >
        BUILDER_OPERATION_DESCRIPTION_LIMIT
    ) {
      failures.push(
        `${operation.operationId} description exceeds Builder ${BUILDER_OPERATION_DESCRIPTION_LIMIT}-character limit`,
      );
    }
  }

  if (
    openApi.components?.securitySchemes?.actionKey?.type !== 'http' ||
    openApi.components?.securitySchemes?.actionKey?.scheme !== 'bearer'
  ) {
    failures.push('Builder schema must retain HTTP Bearer actionKey auth');
  }

  return {
    ok: failures.length === 0,
    failures,
    operationIds,
  };
}
