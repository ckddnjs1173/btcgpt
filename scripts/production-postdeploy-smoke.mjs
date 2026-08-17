import fs from 'node:fs';

const baseUrl =
  process.env.RELAY_PRODUCTION_URL ??
  'https://btc-futures-assistant-relay.btcgpt-ck1173.workers.dev';
const secretFile =
  process.env.RELAY_SECRET_FILE ?? 'secrets/cloudflare-production.json';
const maxMarketAgeMs = Number(
  process.env.PRODUCTION_SMOKE_MAX_MARKET_AGE_MS ?? 15_000,
);

if (!baseUrl.startsWith('https://') || !baseUrl.endsWith('.workers.dev'))
  throw new Error('RELAY_PRODUCTION_URL must be a workers.dev HTTPS URL');
if (!Number.isFinite(maxMarketAgeMs) || maxMarketAgeMs <= 0)
  throw new Error('PRODUCTION_SMOKE_MAX_MARKET_AGE_MS must be positive');

const secrets = JSON.parse(
  fs.readFileSync(secretFile, 'utf8').replace(/^\uFEFF/, ''),
);
if (
  typeof secrets.ACTION_READ_KEY !== 'string' ||
  secrets.ACTION_READ_KEY.length < 16
)
  throw new Error('ACTION_READ_KEY is missing from the relay secret file');

const requestStartedAt = Date.now();
const response = await fetch(new URL('/v1/decision-context/latest', baseUrl), {
  headers: {
    authorization: `Bearer ${secrets.ACTION_READ_KEY}`,
  },
  signal: AbortSignal.timeout(10_000),
});
const body = await response.text();
const responseReceivedAt = Date.now();
if (!response.ok)
  throw new Error(`Decision Context smoke returned HTTP ${response.status}`);

const context = JSON.parse(body);
if (context.version !== 'decision-context-v1')
  throw new Error(`Unexpected Decision Context version: ${context.version}`);
if (typeof context.snapshotId !== 'string' || context.snapshotId.length === 0)
  throw new Error('Decision Context snapshotId is missing');
if (!Number.isFinite(Number(context.marketGeneratedAt)))
  throw new Error('Decision Context marketGeneratedAt is missing');
if (!Number.isFinite(Number(context.generatedAt)))
  throw new Error('Decision Context generatedAt is missing');
if (context.btcCore?.decisionGates === undefined)
  throw new Error('Decision Context BTC decisionGates are missing');

const marketAgeMs = Math.max(
  0,
  responseReceivedAt - Number(context.marketGeneratedAt),
);
const contextAgeMs = Math.max(
  0,
  responseReceivedAt - Number(context.generatedAt),
);
if (marketAgeMs > maxMarketAgeMs)
  throw new Error(
    `Decision Context market data is stale: ${marketAgeMs} ms > ${maxMarketAgeMs} ms`,
  );

const result = {
  ok: true,
  decisionContextVersion: context.version,
  snapshotId: context.snapshotId,
  marketAgeMs,
  contextAgeMs,
  actionRoundTripMs: Math.max(0, responseReceivedAt - requestStartedAt),
  quality: context.btcCore.decisionGates.quality ?? null,
  marketAnalysisAvailable:
    context.btcCore.decisionGates.marketAnalysisAvailable ?? null,
  entryAllowed: context.btcCore.decisionGates.entryAllowed ?? null,
  positionManagementAvailable:
    context.btcCore.decisionGates.positionManagementAvailable ?? null,
  cryptoMarketVersion: context.cryptoMarket?.version ?? null,
  crossVenueVersion: context.cryptoMarket?.crossVenue?.version ?? null,
  optionsVersion: context.external?.optionsV2?.version ?? null,
  onchainVersion: context.external?.onchainV1?.version ?? null,
  timing: {
    marketToRelayMs: context.timing?.marketToRelayMs ?? null,
    contextBuildMs: context.timing?.contextBuildMs ?? null,
  },
};

console.log(JSON.stringify(result, null, 2));
console.log('Production post-deploy smoke passed.');
