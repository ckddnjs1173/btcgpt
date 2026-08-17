import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const notes = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

function note(message) {
  notes.push(message);
}

function compareVersion(actual, required) {
  const parse = (value) =>
    value
      .replace(/^v/, '')
      .split('.')
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(actual);
  const r = parse(required);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > r[index]) return 1;
    if (a[index] < r[index]) return -1;
  }
  return 0;
}

const packageJson = JSON.parse(read('package.json'));
const openApi = JSON.parse(read('worker/openapi/openapi.json'));
const instructions = read('worker/openapi/GPT_INSTRUCTIONS.md');
const actionSetup = read('worker/openapi/GPT_ACTION_SETUP.md');
const wrangler = read('wrangler.toml');

check(compareVersion(process.version, '24.0.0') >= 0, `Node.js 24+ required; found ${process.version}`);
check(packageJson.engines?.node === '>=24.0.0', 'package.json Node engine must remain >=24.0.0');
check(packageJson.engines?.npm === '>=11.0.0', 'package.json npm engine must remain >=11.0.0');

check(openApi.info?.version === '5.9.0', `Expected OpenAPI 5.9.0; found ${openApi.info?.version ?? 'missing'}`);
check(Array.from(instructions).length <= 7_500, `GPT_INSTRUCTIONS.md exceeds 7,500 characters (${Array.from(instructions).length})`);

const expectedOperations = [
  'getDecisionSnapshot',
  'getLatestSnapshot',
  'getExternalContext',
  'validateTradePlan',
  'validatePositionAdjustment',
  'getTradeLifecycle',
  'recordDecision',
];
const actualOperations = Object.values(openApi.paths ?? {})
  .flatMap((pathItem) => Object.values(pathItem ?? {}))
  .filter((operation) => operation && typeof operation === 'object' && 'operationId' in operation)
  .map((operation) => operation.operationId)
  .filter((operationId) => typeof operationId === 'string');
for (const operationId of expectedOperations) {
  check(actualOperations.includes(operationId), `OpenAPI missing operationId ${operationId}`);
  check(actionSetup.includes(`\`${operationId}\``), `GPT_ACTION_SETUP.md missing ${operationId}`);
}

check(actionSetup.includes('OpenAPI **5.9.0**'), 'GPT_ACTION_SETUP.md must name OpenAPI 5.9.0');
check(actionSetup.includes('7,500'), 'GPT_ACTION_SETUP.md must document the 7,500-character instruction budget');
check(actionSetup.includes('getDecisionSnapshot'), 'GPT_ACTION_SETUP.md must use getDecisionSnapshot as the live entry anchor');
check(!actionSetup.includes('context-v2 trading memory'), 'GPT_ACTION_SETUP.md contains obsolete context-v2 wording');

check(wrangler.includes('main = "worker/src/phase25.ts"'), 'wrangler.toml Worker entrypoint changed unexpectedly');
check(wrangler.includes('binding = "DB"'), 'wrangler.toml must retain D1 binding DB');
check(wrangler.includes('database_name = "btc-futures-assistant"'), 'wrangler.toml D1 database name changed unexpectedly');
check(wrangler.includes('migrations_dir = "worker/migrations"'), 'wrangler.toml migrations_dir changed unexpectedly');
check(wrangler.includes('UPLOADER_WRITE_KEY'), 'wrangler.toml must require UPLOADER_WRITE_KEY');
check(wrangler.includes('ACTION_READ_KEY'), 'wrangler.toml must require ACTION_READ_KEY');

const migrationFiles = fs
  .readdirSync(path.join(root, 'worker', 'migrations'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
check(migrationFiles.length > 0, 'No D1 migrations found');
for (let index = 0; index < migrationFiles.length; index += 1) {
  const expectedPrefix = String(index + 1).padStart(4, '0');
  check(migrationFiles[index].startsWith(`${expectedPrefix}_`), `D1 migration sequence gap near ${migrationFiles[index]}`);
}
note(`D1 migrations: ${migrationFiles.length} files, latest ${migrationFiles.at(-1) ?? 'none'}`);
note(`OpenAPI: ${openApi.info?.version ?? 'missing'}`);
note(`GPT instructions: ${Array.from(instructions).length}/7500 characters`);
note(`Worker entrypoint: ${/main = "([^"]+)"/.exec(wrangler)?.[1] ?? 'missing'}`);

if (failures.length > 0) {
  console.error('Production preflight FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Production preflight PASSED');
  for (const message of notes) console.log(`- ${message}`);
  console.log('- Secrets were not read or printed.');
  console.log('- Next: list remote D1 migrations, apply pending migrations, deploy Worker, then refresh the Custom GPT Action schema and Instructions.');
}
