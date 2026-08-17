import { readFile, writeFile } from 'node:fs/promises';

import {
  buildEvidenceAblationReport,
  formatEvidenceAblationMarkdown,
} from './evidence-ablation-report-lib.mjs';
import {
  auditFrozenReplayInput,
  buildFrozenContextAudit,
  formatFrozenContextAuditMarkdown,
} from './frozen-context-audit-lib.mjs';
import {
  buildResearchFinalizationReport,
  formatResearchFinalizationMarkdown,
} from './research-finalize-lib.mjs';

const relayUrl = (process.env.RELAY_URL ?? '').replace(/\/$/, '');
const actionKey = process.env.ACTION_READ_KEY ?? '';
const manifestPath = process.argv[2];
const outputPrefix = process.argv[3] ?? 'research-finalization';

if (!relayUrl || !actionKey || !manifestPath) {
  console.error(
    'Usage: RELAY_URL=https://... ACTION_READ_KEY=... npm run research:finalize -- <campaign-manifest.json> [output-prefix]',
  );
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const decisionIds = Array.isArray(manifest.decisionIds)
  ? manifest.decisionIds
  : Array.isArray(manifest.selectedDecisionIds)
    ? manifest.selectedDecisionIds
    : [];

if (decisionIds.length === 0) {
  throw new Error('decisionIds or selectedDecisionIds are required.');
}
if (!Array.isArray(manifest.profiles) || manifest.profiles.length < 2) {
  throw new Error('At least two ablation profiles are required.');
}

async function relayResult(path) {
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

async function relayRequired(path) {
  const result = await relayResult(path);
  if (!result.ok) {
    throw new Error(`Relay ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

const caseAudits = [];
for (const decisionId of decisionIds) {
  const replayInput = await relayRequired(
    `/v1/replay/case/${encodeURIComponent(decisionId)}/input`,
  );
  caseAudits.push(auditFrozenReplayInput(decisionId, replayInput));
}
const contextAudit = buildFrozenContextAudit(caseAudits);

const benchmarkResults = {};
const pathQualityResults = {};
const cohortResults = {};
for (const profile of manifest.profiles) {
  const experimentId = String(profile.experimentId ?? '');
  if (!experimentId) continue;
  benchmarkResults[experimentId] = await relayResult(
    `/v1/research/benchmark/${encodeURIComponent(experimentId)}`,
  );
  pathQualityResults[experimentId] = await relayResult(
    `/v1/research/path-quality/${encodeURIComponent(experimentId)}`,
  );
  cohortResults[experimentId] = await relayResult(
    `/v1/research/decision-cohorts/${encodeURIComponent(experimentId)}`,
  );
}

const ablationReport = buildEvidenceAblationReport(
  manifest,
  benchmarkResults,
  pathQualityResults,
);
const report = buildResearchFinalizationReport({
  manifest,
  ablationReport,
  contextAudit,
  cohortResults,
});

const jsonPath = `${outputPrefix}.json`;
const markdownPath = `${outputPrefix}.md`;
const ablationPath = `${outputPrefix}.ablation.md`;
const contextAuditPath = `${outputPrefix}.context-audit.md`;

await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(
  markdownPath,
  `${formatResearchFinalizationMarkdown(report)}\n`,
  'utf8',
);
await writeFile(
  ablationPath,
  `${formatEvidenceAblationMarkdown(ablationReport)}\n`,
  'utf8',
);
await writeFile(
  contextAuditPath,
  `${formatFrozenContextAuditMarkdown(contextAudit)}\n`,
  'utf8',
);

console.log(`Research finalization status: ${report.status}`);
console.log(`Wrote ${jsonPath} and ${markdownPath}.`);
console.log(`Wrote supporting reports ${ablationPath} and ${contextAuditPath}.`);
console.log('No paid OpenAI API call was made and production was not changed.');
console.log('This command never promotes a source/model or activates live trading.');
