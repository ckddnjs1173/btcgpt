import { writeFile } from 'node:fs/promises';

const relayUrl = (process.env.RELAY_URL ?? '').replace(/\/$/, '');
const actionKey = process.env.ACTION_READ_KEY ?? '';
const experimentIds = process.argv.slice(2).filter(Boolean);

if (!relayUrl || !actionKey) {
  console.error(
    'Usage: RELAY_URL=https://... ACTION_READ_KEY=... npm run research:report -- [experimentId ...]',
  );
  process.exit(2);
}

async function relay(path) {
  const response = await fetch(`${relayUrl}${path}`, {
    headers: { authorization: `Bearer ${actionKey}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, status: response.status, body };
  }
  return { ok: true, status: response.status, body };
}

const readiness = await relay('/v1/research/readiness');
const feedback = await relay('/v1/research/feedback');
const sizing = await relay('/v1/research/performance-sizing');
const benchmarks = [];
for (const experimentId of experimentIds) {
  benchmarks.push({
    experimentId,
    result: await relay(
      `/v1/research/benchmark/${encodeURIComponent(experimentId)}`,
    ),
  });
}

const report = {
  version: 'research-report-v1',
  generatedAt: Date.now(),
  relayUrl,
  readiness,
  feedback,
  sizing,
  benchmarks,
  paidApiCallMade: false,
};

function value(path, fallback = 'n/a') {
  let current = report;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return fallback;
    current = current[part];
  }
  return current ?? fallback;
}

const lines = [
  '# BTC GPT Research Report',
  '',
  `Generated: ${new Date(report.generatedAt).toISOString()}`,
  '',
  '## Readiness',
  '',
  `- Performance schema: ${value('readiness.body.schema.performanceResearch')}`,
  `- Decisions: ${value('readiness.body.inventory.decisions')}`,
  `- Replay cases: ${value('readiness.body.inventory.replayCases')}`,
  `- Finalized outcomes: ${value('readiness.body.inventory.finalizedOutcomes')}`,
  `- Scored replay runs: ${value('readiness.body.inventory.scoredRuns')}`,
  `- Closed linked trades with Net R: ${value('readiness.body.inventory.closedLinkedTradesWithNetR')}`,
  '',
  '## Live performance feedback',
  '',
  `- Status: ${value('feedback.body.status')}`,
  `- Mean Net R: ${value('feedback.body.performance.meanNetR')}`,
  `- Median Net R: ${value('feedback.body.performance.medianNetR')}`,
  `- Median MFE R: ${value('feedback.body.performance.medianMfeR')}`,
  `- Median MAE R: ${value('feedback.body.performance.medianMaeR')}`,
  `- Median MFE capture ratio: ${value('feedback.body.performance.medianMfeCaptureRatio')}`,
  `- Recent vs prior mean Net R delta: ${value('feedback.body.drift.recentVsPriorMeanNetRDelta')}`,
  '',
  '## Sizing research',
  '',
  `- Status: ${value('sizing.body.status')}`,
  `- Sample count: ${value('sizing.body.sampleCount')}`,
  `- Candidate risk multiplier: ${value('sizing.body.candidateRiskMultiplier.multiplier')}`,
  '- Live sizing/leverage mutation remains disabled.',
];

if (benchmarks.length > 0) {
  lines.push('', '## Benchmarks', '');
  for (const benchmark of benchmarks) {
    const body = benchmark.result.body ?? {};
    lines.push(
      `### ${benchmark.experimentId}`,
      '',
      `- Matched cases: ${body.matchedCases ?? 'n/a'}`,
      `- Promotion evidence: ${body.promotionEvidence?.status ?? 'n/a'}`,
      `- Live 30m signed return bps: ${body.live?.averageSignedReturnBps30m ?? 'n/a'}`,
      `- API 30m signed return bps: ${body.api?.averageSignedReturnBps30m ?? 'n/a'}`,
      `- API reported cost USD: ${body.operational?.apiTotalReportedCostUsd ?? 'n/a'}`,
      '',
    );
  }
}

await writeFile('research-report.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile('research-report.md', `${lines.join('\n')}\n`, 'utf8');
console.log('Wrote research-report.json and research-report.md.');
console.log('No paid OpenAI API call was made.');
