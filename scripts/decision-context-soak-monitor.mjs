import fs from 'node:fs';

const baseUrl = process.env.RELAY_PRODUCTION_URL;
const secretFile =
  process.env.RELAY_SECRET_FILE ?? 'secrets/cloudflare-production.json';
const appPid = Number(process.env.RELAY_APP_PID);
const durationMs = Number(
  process.env.DECISION_CONTEXT_SOAK_DURATION_MS ?? 86_400_000,
);
const sampleMs = Number(process.env.DECISION_CONTEXT_SOAK_SAMPLE_MS ?? 10_000);
const maxMarketAgeMs = Number(
  process.env.DECISION_CONTEXT_MAX_MARKET_AGE_MS ?? 15_000,
);
const targetMaxBytes = Number(
  process.env.DECISION_CONTEXT_TARGET_MAX_BYTES ?? 50_000,
);

if (!baseUrl?.startsWith('https://') || !baseUrl.endsWith('.workers.dev'))
  throw new Error('RELAY_PRODUCTION_URL must be a workers.dev HTTPS URL');
if (!Number.isInteger(appPid) || appPid <= 0)
  throw new Error('RELAY_APP_PID must identify the packaged app');
if (!Number.isFinite(durationMs) || durationMs <= 0)
  throw new Error('DECISION_CONTEXT_SOAK_DURATION_MS must be positive');
if (!Number.isFinite(sampleMs) || sampleMs < 1_000)
  throw new Error('DECISION_CONTEXT_SOAK_SAMPLE_MS must be at least 1000');

const secrets = JSON.parse(
  fs.readFileSync(secretFile, 'utf8').replace(/^\uFEFF/, ''),
);
if (typeof secrets.ACTION_READ_KEY !== 'string')
  throw new Error('Action read key is missing');

function appIsRunning() {
  try {
    process.kill(appPid, 0);
    return true;
  } catch {
    return false;
  }
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

const startedAt = Date.now();
const endAt = startedAt + durationMs;
let samples = 0;
let successfulSamples = 0;
let freshSamples = 0;
let entryAllowedSamples = 0;
let failures = 0;
let firstSnapshotId;
let latestSnapshotId;
let lastProgressAt = 0;
const ages = [];
const payloadBytes = [];
const actionLatencies = [];
const relayLatencies = [];

while (Date.now() < endAt) {
  const cycleStartedAt = Date.now();
  samples += 1;
  try {
    if (!appIsRunning()) throw new Error('Packaged app exited');
    const requestStartedAt = Date.now();
    const response = await fetch(new URL('/v1/decision-context/latest', baseUrl), {
      headers: {
        authorization: `Bearer ${secrets.ACTION_READ_KEY}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    if (!response.ok)
      throw new Error(`Decision Context read returned HTTP ${response.status}`);
    const context = JSON.parse(body);
    if (context.version !== 'decision-context-v1')
      throw new Error('Decision Context version mismatch');
    if (typeof context.snapshotId !== 'string' || context.snapshotId.length < 1)
      throw new Error('Decision Context snapshotId missing');
    if (!Number.isFinite(Number(context.marketGeneratedAt)))
      throw new Error('Decision Context marketGeneratedAt missing');
    if (context.btcCore?.decisionGates === undefined)
      throw new Error('Decision Context BTC gates missing');

    const now = Date.now();
    const ageMs = Math.max(0, now - Number(context.marketGeneratedAt));
    const bytes = Buffer.byteLength(body, 'utf8');
    const actionLatencyMs = now - requestStartedAt;
    ages.push(ageMs);
    payloadBytes.push(bytes);
    actionLatencies.push(actionLatencyMs);
    if (Number.isFinite(Number(context.timing?.marketToRelayMs)))
      relayLatencies.push(Number(context.timing.marketToRelayMs));

    successfulSamples += 1;
    if (ageMs <= maxMarketAgeMs) freshSamples += 1;
    if (context.btcCore.decisionGates.entryAllowed === true)
      entryAllowedSamples += 1;
    firstSnapshotId ??= context.snapshotId;
    latestSnapshotId = context.snapshotId;
  } catch {
    failures += 1;
  }

  if (cycleStartedAt - lastProgressAt >= 60 * 60_000) {
    console.log(
      `Decision-context soak progress: ${Math.round((cycleStartedAt - startedAt) / 60_000)} minutes, ${successfulSamples}/${samples} successful, ${freshSamples} fresh.`,
    );
    lastProgressAt = cycleStartedAt;
  }

  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, sampleMs - (Date.now() - cycleStartedAt))),
  );
}

const successRatio = samples > 0 ? successfulSamples / samples : 0;
const freshRatio = successfulSamples > 0 ? freshSamples / successfulSamples : 0;
const p95AgeMs = percentile(ages, 95);
const p99AgeMs = percentile(ages, 99);
const maxBytes = payloadBytes.length > 0 ? Math.max(...payloadBytes) : null;
const p95Bytes = percentile(payloadBytes, 95);
const p95ActionLatencyMs = percentile(actionLatencies, 95);
const p95RelayLatencyMs = percentile(relayLatencies, 95);

console.log(
  JSON.stringify(
    {
      samples,
      successfulSamples,
      freshSamples,
      entryAllowedSamples,
      failures,
      successRatio,
      freshRatio,
      p95AgeMs,
      p99AgeMs,
      p95Bytes,
      maxBytes,
      p95ActionLatencyMs,
      p95RelayLatencyMs,
      targetMaxBytes,
      targetMaxBytesExceeded:
        maxBytes !== null && Number.isFinite(targetMaxBytes)
          ? maxBytes > targetMaxBytes
          : null,
      firstSnapshotId,
      latestSnapshotId,
      appRunning: appIsRunning(),
    },
    null,
    2,
  ),
);

if (
  samples === 0 ||
  successRatio < 0.99 ||
  freshRatio < 0.95 ||
  !firstSnapshotId ||
  firstSnapshotId === latestSnapshotId ||
  !appIsRunning()
)
  throw new Error(
    `Decision-context soak failed: ${successfulSamples}/${samples} successful, ${freshSamples} fresh, ${failures} failures.`,
  );

if (maxBytes !== null && maxBytes > targetMaxBytes)
  console.warn(
    `Decision Context payload exceeded engineering target: max ${maxBytes} bytes > ${targetMaxBytes} bytes. This is diagnostic, not a hard failure.`,
  );

console.log('Decision-context soak passed.');
