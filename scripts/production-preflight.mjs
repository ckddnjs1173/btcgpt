import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ciMode = process.argv.includes('--ci');
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

function command(executable, args) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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

check(
  compareVersion(process.version, '24.0.0') >= 0,
  `Node.js 24+ required; found ${process.version}`,
);
const npmVersion = command(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
  '--version',
]);
check(compareVersion(npmVersion, '11.0.0') >= 0, `npm 11+ required; found ${npmVersion}`);
check(
  packageJson.engines?.node === '>=24.0.0',
  'package.json Node engine must remain >=24.0.0',
);
check(
  packageJson.engines?.npm === '>=11.0.0',
  'package.json npm engine must remain >=11.0.0',
);

const instructionLength = Array.from(instructions).length;
check(
  instructionLength <= 7_500,
  `GPT_INSTRUCTIONS.md exceeds 7,500 characters (${instructionLength})`,
);
check(
  instructions.includes('getDecisionSnapshot'),
  'GPT_INSTRUCTIONS.md must use getDecisionSnapshot',
);
check(
  instructions.includes('decision-context-v1'),
  'GPT_INSTRUCTIONS.md must identify decision-context-v1',
);

const setupOpenApiVersion = /OpenAPI \*\*([0-9.]+)\*\*/.exec(actionSetup)?.[1];
check(
  setupOpenApiVersion === openApi.info?.version,
  `GPT_ACTION_SETUP.md/OpenAPI version mismatch (${setupOpenApiVersion ?? 'missing'} vs ${openApi.info?.version ?? 'missing'})`,
);
check(
  actionSetup.includes('7,500'),
  'GPT_ACTION_SETUP.md must document the 7,500-character instruction budget',
);
check(
  actionSetup.includes('공식 live anchor'),
  'GPT_ACTION_SETUP.md must explicitly identify the official live anchor',
);
check(
  !actionSetup.includes('context-v2 trading memory'),
  'GPT_ACTION_SETUP.md contains obsolete context-v2 wording',
);

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
  .filter(
    (operation) =>
      operation && typeof operation === 'object' && 'operationId' in operation,
  )
  .map((operation) => operation.operationId)
  .filter((operationId) => typeof operationId === 'string');
for (const operationId of expectedOperations) {
  check(
    actualOperations.includes(operationId),
    `OpenAPI missing operationId ${operationId}`,
  );
  check(
    actionSetup.includes(`\`${operationId}\``),
    `GPT_ACTION_SETUP.md missing ${operationId}`,
  );
}

check(
  openApi.servers?.[0]?.url ===
    'https://btc-futures-assistant-relay.btcgpt-ck1173.workers.dev',
  'OpenAPI production server URL changed unexpectedly',
);
check(
  openApi.components?.securitySchemes?.actionKey?.type === 'http' &&
    openApi.components?.securitySchemes?.actionKey?.scheme === 'bearer',
  'OpenAPI actionKey must remain HTTP Bearer auth',
);

check(
  wrangler.includes('main = "worker/src/phase25.ts"'),
  'wrangler.toml Worker entrypoint changed unexpectedly',
);
check(wrangler.includes('binding = "DB"'), 'wrangler.toml must retain D1 binding DB');
check(
  wrangler.includes('database_name = "btc-futures-assistant"'),
  'wrangler.toml D1 database name changed unexpectedly',
);
check(
  wrangler.includes('migrations_dir = "worker/migrations"'),
  'wrangler.toml migrations_dir changed unexpectedly',
);
check(
  wrangler.includes('UPLOADER_WRITE_KEY'),
  'wrangler.toml must require UPLOADER_WRITE_KEY',
);
check(
  wrangler.includes('ACTION_READ_KEY'),
  'wrangler.toml must require ACTION_READ_KEY',
);

const migrationFiles = fs
  .readdirSync(path.join(root, 'worker', 'migrations'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
check(migrationFiles.length > 0, 'No D1 migrations found');
for (let index = 0; index < migrationFiles.length; index += 1) {
  const expectedPrefix = String(index + 1).padStart(4, '0');
  check(
    migrationFiles[index].startsWith(`${expectedPrefix}_`),
    `D1 migration sequence gap near ${migrationFiles[index]}`,
  );
}

if (!ciMode) {
  const branch = command('git', ['branch', '--show-current']);
  check(branch === 'main', `Production preflight must run on main; found ${branch || 'detached HEAD'}`);
  const workingTree = command('git', ['status', '--porcelain']);
  check(workingTree.length === 0, 'Working tree must be clean before production deployment');

  try {
    const head = command('git', ['rev-parse', 'HEAD']);
    const originMain = command('git', ['rev-parse', 'origin/main']);
    check(
      head === originMain,
      'HEAD differs from origin/main; run git fetch/pull before production deployment',
    );
  } catch {
    note('origin/main could not be compared; run git fetch origin before deploying.');
  }

  check(
    fs.existsSync(path.join(root, 'secrets', 'cloudflare-production.json')),
    'secrets/cloudflare-production.json is missing (contents are never read by preflight)',
  );
}

note(`Node/npm: ${process.version} / ${npmVersion}`);
note(
  `D1 migrations: ${migrationFiles.length} files, latest ${migrationFiles.at(-1) ?? 'none'}`,
);
note(`OpenAPI: ${openApi.info?.version ?? 'missing'}`);
note(`GPT instructions: ${instructionLength}/7500 characters`);
note(`Worker entrypoint: ${/main = "([^"]+)"/.exec(wrangler)?.[1] ?? 'missing'}`);

if (failures.length > 0) {
  console.error('Production preflight FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Production preflight PASSED');
  for (const message of notes) console.log(`- ${message}`);
  console.log('- Secret contents were not read or printed.');
}
