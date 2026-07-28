import fs from 'node:fs';
import crypto from 'node:crypto';

const baseUrl = process.env.RELAY_PRODUCTION_URL;
const secretFile =
  process.env.RELAY_SECRET_FILE ?? 'secrets/cloudflare-production.json';
const durationMs = Number(process.env.RELAY_SOAK_DURATION_MS ?? 86_400_000);
const intervalMs = Number(process.env.RELAY_SOAK_INTERVAL_MS ?? 5_000);

if (!baseUrl?.startsWith('https://') || !baseUrl.endsWith('.workers.dev'))
  throw new Error('RELAY_PRODUCTION_URL must be a workers.dev HTTPS URL');
if (
  !Number.isFinite(durationMs) ||
  durationMs <= 0 ||
  !Number.isFinite(intervalMs) ||
  intervalMs < 1_000
)
  throw new Error('Invalid relay soak duration or interval');

const secrets = JSON.parse(
  fs.readFileSync(secretFile, 'utf8').replace(/^\uFEFF/, ''),
);
const uploadKey = secrets.UPLOADER_WRITE_KEY;
const readKey = secrets.ACTION_READ_KEY;
if (
  typeof uploadKey !== 'string' ||
  typeof readKey !== 'string' ||
  uploadKey === readKey
)
  throw new Error('Separated relay secrets are required');

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`${method} ${path} returned HTTP ${response.status}`);
  return response;
}

function snapshot() {
  return {
    schemaVersion: 1,
    snapshotId: crypto.randomUUID(),
    symbol: 'BTCUSDT',
    market: 'BINANCE_USDM_PERPETUAL',
    generatedAt: Date.now(),
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
}

const plan = {
  side: 'LONG',
  entry: 60_000,
  stop: 59_500,
  targets: [61_000],
  maxLossUsdt: 50,
  leverage: 10,
  marginMode: 'ISOLATED',
};
const startedAt = Date.now();
const endAt = startedAt + durationMs;
let attempts = 0;
let uploads = 0;
let reads = 0;
let plans = 0;
let failures = 0;
let lastReadAt = 0;
let lastPlanAt = 0;
let lastProgressAt = 0;

while (Date.now() < endAt) {
  const cycleStartedAt = Date.now();
  attempts += 1;
  try {
    await request('/v1/snapshot/latest', {
      method: 'PUT',
      token: uploadKey,
      body: snapshot(),
    });
    uploads += 1;

    if (cycleStartedAt - lastReadAt >= 60_000) {
      const response = await request('/v1/snapshot/latest', {
        token: readKey,
      });
      const body = await response.json();
      if (
        body.symbol !== 'BTCUSDT' ||
        body.analysisGate?.analysisAllowed !== true
      )
        throw new Error('Read-back snapshot failed validation');
      reads += 1;
      lastReadAt = cycleStartedAt;
    }

    if (cycleStartedAt - lastPlanAt >= 3_600_000) {
      const response = await request('/v1/plan/validate', {
        method: 'POST',
        token: readKey,
        body: plan,
      });
      const body = await response.json();
      if (body.ok !== true || !(body.quantity > 0))
        throw new Error('Plan validation failed');
      plans += 1;
      lastPlanAt = cycleStartedAt;
    }
  } catch {
    failures += 1;
  }

  if (cycleStartedAt - lastProgressAt >= 3_600_000) {
    console.log(
      `Relay soak progress: ${Math.round((cycleStartedAt - startedAt) / 60_000)} minutes, ${uploads} uploads, ${failures} failures.`,
    );
    lastProgressAt = cycleStartedAt;
  }
  const delay = Math.max(0, intervalMs - (Date.now() - cycleStartedAt));
  await new Promise((resolve) => setTimeout(resolve, delay));
}

const successRatio = attempts > 0 ? uploads / attempts : 0;
if (attempts === 0 || successRatio < 0.99 || reads === 0 || plans === 0)
  throw new Error(
    `Relay soak failed: ${attempts} attempts, ${uploads} uploads, ${reads} reads, ${plans} plans, ${failures} failures.`,
  );

console.log(
  `Relay production soak passed: ${uploads}/${attempts} uploads, ${reads} reads, ${plans} plan validations, ${failures} failures.`,
);
