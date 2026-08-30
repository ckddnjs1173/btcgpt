import fs from 'node:fs';
import path from 'node:path';

import {
  buildBuilderSchema,
  validateBuilderSchema,
  validateInstructions,
} from './gpt-builder-export-lib.mjs';

const root = process.cwd();
const target = process.argv[2];
const checkOnly = process.argv.includes('--check');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputPath = outputArg ? outputArg.slice('--output='.length) : null;

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function write(text) {
  if (checkOnly) return;
  if (outputPath) {
    fs.writeFileSync(path.resolve(outputPath), text, 'utf8');
    return;
  }
  process.stdout.write(text);
}

function fail(messages) {
  for (const message of messages) console.error(`- ${message}`);
  process.exitCode = 1;
}

const instructions = read('worker/openapi/GPT_INSTRUCTIONS.md');
const instructionCheck = validateInstructions(instructions);
if (!instructionCheck.ok) {
  console.error('GPT Builder instructions export FAILED');
  fail(instructionCheck.failures);
} else if (target === 'instructions') {
  write(instructions);
}

const sourceOpenApi = JSON.parse(read('worker/openapi/openapi.json'));
const builderOpenApi = buildBuilderSchema(sourceOpenApi);
const schemaCheck = validateBuilderSchema(builderOpenApi);
if (!schemaCheck.ok) {
  console.error('GPT Builder schema export FAILED');
  fail(schemaCheck.failures);
} else if (target === 'schema') {
  write(`${JSON.stringify(builderOpenApi, null, 2)}\n`);
}

if (process.exitCode) process.exit();

if (checkOnly) {
  console.log('GPT Builder export check PASSED');
  console.log(
    `- Instructions: ${instructionCheck.length}/7500 internal, 8000 Builder`,
  );
  console.log(`- Operations: ${schemaCheck.operationIds.join(', ')}`);
  console.log('- Builder operation descriptions: <=300 characters');
} else if (target !== 'instructions' && target !== 'schema') {
  console.error(
    'Usage: node scripts/gpt-builder-export.mjs <instructions|schema> [--output=<path>] [--check]',
  );
  process.exitCode = 1;
}
