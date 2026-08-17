import { readFile, writeFile } from 'node:fs/promises';

import {
  auditFrozenReplayInput,
  buildFrozenContextAudit,
  formatFrozenContextAuditMarkdown,
} from './frozen-context-audit-lib.mjs';

const relayUrl = (process.env.RELAY_URL ?? '').replace(/\/$/, '');
const actionKey = process.env.ACTION_READ_KEY ?? '';
const configPath = process.argv[2];
const outputPrefix = process.argv[3] ?? 'frozen-context-audit';

if (!relayUrl || !actionKey || !configPath) {
  console.error(
    'Usage: RELAY_URL=https://... ACTION_READ_KEY=... npm run research:context-audit -- <experiment-or-campaign.json> [output-prefix]',
  );
  process.exit(2);
}

const config = JSON.parse(await readFile(configPath, 'utf8'));
const decisionIds = Array.isArray(config.decisionIds)
  ? config.decisionIds
  : Array.isArray(config.selectedDecisionIds)
    ? config.selectedDecisionIds
    : [];

if (decisionIds.length === 0) {
  throw new Error('decisionIds or selectedDecisionIds are required.');
}

async function relay(path) {
  const response = await fetch(`${relayUrl}${path}`, {
    headers: {
      authorization: `Bearer ${actionKey}`,
      'content-type': 'application/json',
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Relay ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const audits = [];
for (const decisionId of decisionIds) {
  const replayInput = await relay(
    `/v1/replay/case/${encodeURIComponent(decisionId)}/input`,
  );
  audits.push(auditFrozenReplayInput(decisionId, replayInput));
}

const report = buildFrozenContextAudit(audits);
const jsonPath = `${outputPrefix}.json`;
const markdownPath = `${outputPrefix}.md`;

await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(
  markdownPath,
  `${formatFrozenContextAuditMarkdown(report)}\n`,
  'utf8',
);

console.log(`Audited ${report.caseCount} frozen replay cases.`);
console.log(
  `Valid decision-context-v1 cases: ${report.validDecisionContextCases}/${report.caseCount}.`,
);
console.log(`Wrote ${jsonPath} and ${markdownPath}.`);
console.log('No OpenAI API call was made and production was not changed.');
