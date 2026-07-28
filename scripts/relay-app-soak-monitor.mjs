import fs from 'node:fs';

const baseUrl = process.env.RELAY_PRODUCTION_URL;
const secretFile =
  process.env.RELAY_SECRET_FILE ?? 'secrets/cloudflare-production.json';
const appPid = Number(process.env.RELAY_APP_PID);
const durationMs = Number(process.env.RELAY_APP_SOAK_DURATION_MS ?? 86_400_000);
const sampleMs = Number(process.env.RELAY_APP_SOAK_SAMPLE_MS ?? 30_000);

if (!baseUrl?.startsWith('https://') || !baseUrl.endsWith('.workers.dev'))
  throw new Error('RELAY_PRODUCTION_URL must be a workers.dev HTTPS URL');
if (!Number.isInteger(appPid) || appPid <= 0)
  throw new Error('RELAY_APP_PID must identify the packaged app');

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

const startedAt = Date.now();
const endAt = startedAt + durationMs;
let samples = 0;
let successfulSamples = 0;
let usableSamples = 0;
let failures = 0;
let maxAgeMs = 0;
let firstSnapshotId;
let latestSnapshotId;
let lastProgressAt = 0;

while (Date.now() < endAt) {
  const cycleStartedAt = Date.now();
  samples += 1;
  try {
    if (!appIsRunning()) throw new Error('Packaged app exited');
    const response = await fetch(new URL('/v1/snapshot/latest', baseUrl), {
      headers: {
        authorization: `Bearer ${secrets.ACTION_READ_KEY}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`Snapshot read returned HTTP ${response.status}`);
    const snapshot = await response.json();
    const frameCounts = ['5m', '15m', '1h', '4h'].map(
      (timeframe) => snapshot.timeframes?.[timeframe]?.closed?.length ?? 0,
    );
    if (
      snapshot.symbol !== 'BTCUSDT' ||
      frameCounts.some((count) => count < 120)
    )
      throw new Error('Snapshot is incomplete');
    const ageMs = Number(snapshot.analysisGate?.ageMs);
    if (!Number.isFinite(ageMs) || ageMs > 15_000)
      throw new Error('Snapshot is stale');
    maxAgeMs = Math.max(maxAgeMs, ageMs);
    successfulSamples += 1;
    if (
      snapshot.analysisGate?.overallStatus === 'NORMAL' ||
      snapshot.analysisGate?.overallStatus === 'DELAYED'
    )
      usableSamples += 1;
    firstSnapshotId ??= snapshot.snapshotId;
    latestSnapshotId = snapshot.snapshotId;
  } catch {
    failures += 1;
  }

  if (cycleStartedAt - lastProgressAt >= 3_600_000) {
    console.log(
      `Packaged-app relay soak progress: ${Math.round((cycleStartedAt - startedAt) / 60_000)} minutes, ${successfulSamples}/${samples} fresh snapshots.`,
    );
    lastProgressAt = cycleStartedAt;
  }
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, sampleMs - (Date.now() - cycleStartedAt))),
  );
}

const successRatio = samples > 0 ? successfulSamples / samples : 0;
const usableRatio =
  successfulSamples > 0 ? usableSamples / successfulSamples : 0;
if (
  samples === 0 ||
  successRatio < 0.99 ||
  usableRatio < 0.95 ||
  !firstSnapshotId ||
  firstSnapshotId === latestSnapshotId ||
  !appIsRunning()
)
  throw new Error(
    `Packaged-app relay soak failed: ${successfulSamples}/${samples} fresh, ${usableSamples} usable, ${failures} failures.`,
  );

console.log(
  `Packaged-app relay soak passed: ${successfulSamples}/${samples} fresh snapshots, ${usableSamples} usable, max age ${maxAgeMs}ms, ${failures} failures.`,
);
