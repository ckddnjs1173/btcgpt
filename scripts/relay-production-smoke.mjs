import fs from 'node:fs';
import crypto from 'node:crypto';

const baseUrl = process.argv[2];
const secretFile = process.argv[3] ?? 'secrets/cloudflare-production.json';

if (!baseUrl?.startsWith('https://') || !baseUrl.endsWith('.workers.dev'))
  throw new Error('Expected a workers.dev HTTPS base URL');

const secrets = JSON.parse(
  fs.readFileSync(secretFile, 'utf8').replace(/^\uFEFF/, ''),
);
const uploadKey = secrets.UPLOADER_WRITE_KEY;
const readKey = secrets.ACTION_READ_KEY;
if (
  typeof uploadKey !== 'string' ||
  typeof readKey !== 'string' ||
  uploadKey.length < 32 ||
  readKey.length < 32 ||
  uploadKey === readKey
)
  throw new Error('Relay secrets are missing, too short, or not separated');

async function request(path, { method = 'GET', token, body } = {}) {
  return fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
}

function expectStatus(response, expected, label) {
  if (response.status !== expected)
    throw new Error(
      `${label}: expected HTTP ${expected}, received ${response.status}`,
    );
}

const health = await request('/health');
expectStatus(health, 200, 'health');

expectStatus(
  await request('/v1/snapshot/latest'),
  401,
  'unauthenticated snapshot read',
);
expectStatus(
  await request('/v1/snapshot/latest', { token: uploadKey }),
  401,
  'upload key used for snapshot read',
);

const generatedAt = Date.now();
const snapshotId = crypto.randomUUID();
const snapshot = {
  schemaVersion: 1,
  snapshotId,
  symbol: 'BTCUSDT',
  market: 'BINANCE_USDM_PERPETUAL',
  generatedAt,
  analysisGate: {
    analysisAllowed: true,
    overallStatus: 'NORMAL',
    reasons: [],
  },
  marketState: { fundingRate: 0.0001 },
  productFilters: {
    tickSize: 0.1,
    stepSize: 0.001,
    minQuantity: 0.001,
    minNotional: 5,
  },
  costSettings: {
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
    entrySlippageBps: 1,
    exitSlippageBps: 1,
  },
  account: { availableBalance: 1000 },
};

expectStatus(
  await request('/v1/snapshot/latest', {
    method: 'PUT',
    token: readKey,
    body: snapshot,
  }),
  401,
  'read key used for upload',
);
expectStatus(
  await request('/v1/snapshot/latest', {
    method: 'PUT',
    token: uploadKey,
    body: snapshot,
  }),
  200,
  'valid snapshot upload',
);

const read = await request('/v1/snapshot/latest', { token: readKey });
expectStatus(read, 200, 'authorized snapshot read');
const returnedSnapshot = await read.json();
if (
  returnedSnapshot.snapshotId !== snapshotId ||
  returnedSnapshot.analysisGate?.analysisAllowed !== true
)
  throw new Error('D1 snapshot round-trip did not preserve the fresh snapshot');

const plan = {
  side: 'LONG',
  entry: 60_000,
  stop: 59_500,
  targets: [61_000, 62_000],
  maxLossUsdt: 50,
  leverage: 10,
  marginMode: 'ISOLATED',
};
const validation = await request('/v1/plan/validate', {
  method: 'POST',
  token: readKey,
  body: plan,
});
expectStatus(validation, 200, 'fresh plan validation');
const validationBody = await validation.json();
if (
  validationBody.ok !== true ||
  !(validationBody.quantity > 0) ||
  validationBody.targets?.length !== 2
)
  throw new Error('Plan validation returned an invalid calculation result');

await new Promise((resolve) => setTimeout(resolve, 16_000));

const staleRead = await request('/v1/snapshot/latest', {
  token: readKey,
});
expectStatus(staleRead, 200, 'stale snapshot read');
const staleSnapshot = await staleRead.json();
if (
  staleSnapshot.analysisGate?.analysisAllowed !== false ||
  staleSnapshot.analysisGate?.overallStatus !== 'STALE'
)
  throw new Error('Stale snapshot was not forced into analysis-blocked state');

expectStatus(
  await request('/v1/plan/validate', {
    method: 'POST',
    token: readKey,
    body: plan,
  }),
  409,
  'stale plan validation',
);

console.log(
  'Relay production smoke passed: auth separation, D1 round-trip, plan validation, and stale blocking.',
);
