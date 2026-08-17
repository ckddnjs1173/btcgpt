import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { resolveNpmInvocation } from './production-deploy-command.mjs';

const APPLY_FLAG = '--apply';
const CONFIRM_PREFIX = '--confirm=';
const EXPECTED_CONFIRMATION = 'btc-futures-assistant-relay';
const DATABASE = 'btc-futures-assistant';
const DEFAULT_RELAY_URL =
  'https://btc-futures-assistant-relay.btcgpt-ck1173.workers.dev';
const SECRET_FILE =
  process.env.RELAY_SECRET_FILE ?? 'secrets/cloudflare-production.json';
const apply = process.argv.includes(APPLY_FLAG);
const confirmation = process.argv
  .find((arg) => arg.startsWith(CONFIRM_PREFIX))
  ?.slice(CONFIRM_PREFIX.length);

function run(executable, args, options = {}) {
  console.log(`\n> ${[executable, ...args].join(' ')}`);
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Command failed with exit code ${result.status}`);
}

function npm(args, options) {
  const invocation = resolveNpmInvocation();
  run(invocation.executable, [...invocation.prefixArgs, ...args], options);
}

console.log('BTC Futures Assistant production deploy orchestrator');
console.log(`Mode: ${apply ? 'APPLY' : 'READ_ONLY_PLAN'}`);
console.log(`D1 database: ${DATABASE}`);
console.log(`Worker confirmation token: ${EXPECTED_CONFIRMATION}`);
console.log('Secret values are never printed by this orchestrator.');

npm(['run', 'ops:preflight']);
npm(['exec', 'wrangler', '--', 'whoami']);
npm(['exec', 'wrangler', '--', 'deploy', '--dry-run']);
npm([
  'exec',
  'wrangler',
  '--',
  'd1',
  'migrations',
  'list',
  DATABASE,
  '--remote',
]);

if (!apply) {
  console.log('\nREAD_ONLY_PLAN completed. Production was not changed.');
  console.log(
    `To apply migrations, deploy the Worker, and run the authenticated smoke check, rerun with: -- ${APPLY_FLAG} ${CONFIRM_PREFIX}${EXPECTED_CONFIRMATION}`,
  );
  process.exit(0);
}

if (confirmation !== EXPECTED_CONFIRMATION) {
  throw new Error(
    `Refusing production changes. Pass ${CONFIRM_PREFIX}${EXPECTED_CONFIRMATION} together with ${APPLY_FLAG}.`,
  );
}

console.log(
  '\nAPPLY mode confirmed. Remote D1 migrations are applied before Worker deploy.',
);
console.log(
  'Important: if a later deploy step fails, already-applied D1 migrations are not automatically rolled back.',
);

npm([
  'exec',
  'wrangler',
  '--',
  'd1',
  'migrations',
  'apply',
  DATABASE,
  '--remote',
]);

npm([
  'exec',
  'wrangler',
  '--',
  'deploy',
  '--secrets-file',
  path.normalize(SECRET_FILE),
  '--strict',
]);

const smokeEnv = {
  ...process.env,
  RELAY_PRODUCTION_URL: process.env.RELAY_PRODUCTION_URL ?? DEFAULT_RELAY_URL,
  RELAY_SECRET_FILE: SECRET_FILE,
};
npm(['run', 'ops:postdeploy-smoke'], { env: smokeEnv });

console.log('\nProduction deployment sequence completed successfully.');
console.log(
  'Next manual step: refresh the Custom GPT Action schema and GPT Instructions from this exact main revision, then run GPT Preview getDecisionSnapshot.',
);
