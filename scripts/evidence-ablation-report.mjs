import { readFile, writeFile } from 'node:fs/promises';

import {
  buildEvidenceAblationReport,
  formatEvidenceAblationMarkdown,
} from './evidence-ablation-report-lib.mjs';

const relayUrl = (process.env.RELAY_URL ?? '').replace(/\/$/, '');
const actionKey = process.env.ACTION_READ_KEY ?? '';
const manifestPath = process.argv[2];
const outputPrefix = process.argv[3] ?? 'evidence-ablation-report';

if (!relayUrl || !actionKey || !manifestPath) {
  console.error(
    'Usage: RELAY_URL=https://... ACTION_READ_KEY=... npm run research:ablation:report -- <campaign-manifest.json> [output-prefix]',
  );
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const benchmarkResults = {};
const pathQualityResults = {};

async function relay(path) {
  const response = await fetch(`${relayUrl}${path}`, {
    headers: { authorization: `Bearer ${actionKey}` },
  });
  const body = await response.json().catch(() => null);
  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

for (const profile of manifest.profiles ?? []) {
  const experimentId = String(profile.experimentId ?? '');
  if (!experimentId) continue;
  benchmarkResults[experimentId] = await relay(
    `/v1/research/benchmark/${encodeURIComponent(experimentId)}`,
  );
  pathQualityResults[experimentId] = await relay(
    `/v1/research/path-quality/${encodeURIComponent(experimentId)}`,
  );
}

const report = buildEvidenceAblationReport(
  manifest,
  benchmarkResults,
  pathQualityResults,
);
const jsonPath = `${outputPrefix}.json`;
const markdownPath = `${outputPrefix}.md`;

await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(
  markdownPath,
  `${formatEvidenceAblationMarkdown(report)}\n`,
  'utf8',
);

console.log(`Wrote ${jsonPath} and ${markdownPath}.`);
console.log(
  `Manual comparison integrity: ${report.integrity.validForManualComparison}`,
);
console.log(
  `Path-quality profiles available: ${report.integrity.pathQualityProfilesAvailable}/${report.profileCount}.`,
);
console.log('No paid OpenAI API call was made.');
