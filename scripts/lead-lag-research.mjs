import { writeFile } from 'node:fs/promises';

import { analyzeLeadLag } from './lead-lag-lib.mjs';

const relayUrl = (process.env.RELAY_URL ?? '').replace(/\/$/, '');
const actionKey = process.env.ACTION_READ_KEY ?? '';
const args = new Map(
  process.argv
    .slice(2)
    .filter((value) => value.startsWith('--') && value.includes('='))
    .map((value) => {
      const [key, ...rest] = value.slice(2).split('=');
      return [key, rest.join('=')];
    }),
);

const requestedLimit = Number(args.get('limit') ?? 500);
const limit = Number.isSafeInteger(requestedLimit)
  ? Math.min(500, Math.max(1, requestedLimit))
  : 500;
const requestedMinSamples = Number(args.get('min-samples') ?? 20);
const minSamples = Number.isSafeInteger(requestedMinSamples)
  ? Math.max(5, requestedMinSamples)
  : 20;
const outputPrefix = args.get('out') ?? 'lead-lag-report';

if (!relayUrl || !actionKey) {
  console.error(
    'Usage: RELAY_URL=https://... ACTION_READ_KEY=... npm run research:lead-lag -- [--limit=500] [--min-samples=20] [--out=lead-lag-report]',
  );
  process.exit(2);
}

async function relay(path) {
  const response = await fetch(`${relayUrl}${path}`, {
    headers: { authorization: `Bearer ${actionKey}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`RELAY_${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function parallelMap(values, concurrency, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        output[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

const catalog = await relay(`/v1/research/cases?finalized=true&limit=${limit}`);
const catalogCases = Array.isArray(catalog?.cases) ? catalog.cases : [];
const failures = [];

const cases = (
  await parallelMap(catalogCases, 8, async (entry) => {
    const decisionId =
      typeof entry?.decisionId === 'string' ? entry.decisionId : null;
    if (!decisionId) return null;
    try {
      const [input, outcome] = await Promise.all([
        relay(`/v1/replay/case/${encodeURIComponent(decisionId)}/input`),
        relay(`/v1/replay/case/${encodeURIComponent(decisionId)}/outcome`),
      ]);
      return { decisionId, input, outcome };
    } catch (error) {
      failures.push({
        decisionId,
        error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
      });
      return null;
    }
  })
).filter(Boolean);

const analysis = analyzeLeadLag(cases, { minSamples });
const report = {
  ...analysis,
  relayUrl,
  requestedCaseLimit: limit,
  catalogCaseCount: catalogCases.length,
  fetchFailureCount: failures.length,
  fetchFailures: failures.slice(0, 50),
  paidApiCallMade: false,
};

function strongestPairs(features) {
  const rows = [];
  for (const [feature, horizons] of Object.entries(features)) {
    for (const [horizon, stats] of Object.entries(horizons)) {
      if (stats.sampleStatus !== 'RESEARCH_READY') continue;
      const correlation = stats.spearmanCorrelation;
      if (typeof correlation !== 'number' || !Number.isFinite(correlation))
        continue;
      rows.push({
        feature,
        horizon,
        sampleCount: stats.sampleCount,
        spearmanCorrelation: correlation,
        pearsonCorrelation: stats.pearsonCorrelation,
        topMinusBottomMedianFutureReturnBps:
          stats.tails.topMinusBottomMedianFutureReturnBps,
      });
    }
  }
  return rows
    .sort(
      (left, right) =>
        Math.abs(right.spearmanCorrelation) -
          Math.abs(left.spearmanCorrelation) ||
        right.sampleCount - left.sampleCount ||
        left.feature.localeCompare(right.feature),
    )
    .slice(0, 20);
}

const strongest = strongestPairs(report.features);
const lines = [
  '# Lead/Lag Replay Research',
  '',
  `Generated: ${new Date(report.generatedAt).toISOString()}`,
  `Catalog cases: ${report.catalogCaseCount}`,
  `Usable cases: ${report.usableCases}`,
  `Fetch failures: ${report.fetchFailureCount}`,
  `Minimum samples per pair: ${report.minimumSamplesPerPair}`,
  '',
  '## Interpretation boundary',
  '',
  '- Frozen decision-time evidence only.',
  '- Later BTC relay mark-price returns are outcome labels.',
  '- Association is not causality.',
  '- This report never creates a live LONG/SHORT rule or automatic promotion.',
  '',
  '## Strongest research-ready associations',
  '',
];

if (strongest.length === 0) {
  lines.push('- No feature/horizon pair has enough samples yet.');
} else {
  for (const row of strongest) {
    lines.push(
      `- ${row.feature} -> BTC +${row.horizon}: n=${row.sampleCount}, Spearman=${row.spearmanCorrelation.toFixed(3)}, Pearson=${row.pearsonCorrelation === null ? 'n/a' : row.pearsonCorrelation.toFixed(3)}, top-bottom median=${row.topMinusBottomMedianFutureReturnBps === null ? 'n/a' : row.topMinusBottomMedianFutureReturnBps.toFixed(2)} bps`,
    );
  }
}

await writeFile(
  `${outputPrefix}.json`,
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await writeFile(`${outputPrefix}.md`, `${lines.join('\n')}\n`, 'utf8');
console.log(`Wrote ${outputPrefix}.json and ${outputPrefix}.md.`);
console.log('No paid API call was made and no live trading rule was produced.');
