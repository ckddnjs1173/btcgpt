import { readFile, writeFile } from 'node:fs/promises';

const relayUrl = (process.env.RELAY_URL ?? '').replace(/\/$/, '');
const actionKey = process.env.ACTION_READ_KEY ?? '';
const specPath = process.argv[2];
const outputPrefix = process.argv[3] ?? 'replay-campaign';

if (!relayUrl || !actionKey || !specPath) {
  console.error(
    'Usage: RELAY_URL=... ACTION_READ_KEY=... npm run replay:campaign:prepare -- <campaign-spec.json> [output-prefix]',
  );
  process.exit(2);
}

const spec = JSON.parse(await readFile(specPath, 'utf8'));
const registry = spec.registry;
const instructionsPath = String(
  spec.instructionsPath ?? 'worker/openapi/GPT_INSTRUCTIONS.md',
);
const sampleSize = Number(spec.sampleSize ?? 60);
const decisionClasses = Array.isArray(spec.decisionClasses)
  ? spec.decisionClasses.map(String)
  : ['ENTER_NOW', 'WAIT_TRIGGER', 'NO_TRADE'];
const contextPackVersion = spec.contextPackVersion
  ? String(spec.contextPackVersion)
  : null;
const instructionVersion = spec.sourceInstructionVersion
  ? String(spec.sourceInstructionVersion)
  : null;
const sourceAnalysisMode = spec.sourceAnalysisMode
  ? String(spec.sourceAnalysisMode)
  : null;

if (!registry?.experimentId || !registry?.model) {
  throw new Error('registry.experimentId and registry.model are required.');
}
if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > 500) {
  throw new Error('sampleSize must be an integer between 1 and 500.');
}
if (decisionClasses.length === 0 || decisionClasses.length > 9) {
  throw new Error('decisionClasses must contain between 1 and 9 values.');
}

const instructions = (await readFile(instructionsPath, 'utf8')).trim();
if (!instructions) throw new Error('The selected instructions file is empty.');

async function relay(path) {
  const response = await fetch(`${relayUrl}${path}`, {
    headers: { authorization: `Bearer ${actionKey}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Relay ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function catalogPath(decision) {
  const params = new URLSearchParams({
    finalized: 'true',
    decision,
    limit: '500',
  });
  if (contextPackVersion)
    params.set('contextPackVersion', contextPackVersion);
  if (instructionVersion) params.set('instructionVersion', instructionVersion);
  if (sourceAnalysisMode) params.set('analysisMode', sourceAnalysisMode);
  return `/v1/research/cases?${params.toString()}`;
}

function evenlySample(rows, count) {
  if (count <= 0 || rows.length === 0) return [];
  if (count >= rows.length) return [...rows];
  if (count === 1) return [rows[Math.floor((rows.length - 1) / 2)]];
  const selected = [];
  const seen = new Set();
  for (let index = 0; index < count; index += 1) {
    const position = Math.round((index * (rows.length - 1)) / (count - 1));
    const row = rows[position];
    if (row && !seen.has(row.decisionId)) {
      seen.add(row.decisionId);
      selected.push(row);
    }
  }
  return selected;
}

const catalogs = new Map();
for (const decision of decisionClasses) {
  const catalog = await relay(catalogPath(decision));
  catalogs.set(decision, Array.isArray(catalog.cases) ? catalog.cases : []);
}

const selected = [];
const selectedIds = new Set();
const baseQuota = Math.floor(sampleSize / decisionClasses.length);
let remainder = sampleSize % decisionClasses.length;

for (const decision of decisionClasses) {
  const rows = catalogs.get(decision) ?? [];
  const quota = baseQuota + (remainder > 0 ? 1 : 0);
  if (remainder > 0) remainder -= 1;
  for (const row of evenlySample(rows, quota)) {
    if (!selectedIds.has(row.decisionId)) {
      selectedIds.add(row.decisionId);
      selected.push(row);
    }
  }
}

if (selected.length < sampleSize) {
  const leftovers = [...catalogs.values()]
    .flat()
    .filter((row) => !selectedIds.has(row.decisionId))
    .sort(
      (left, right) =>
        left.marketGeneratedAt - right.marketGeneratedAt ||
        left.decisionId.localeCompare(right.decisionId),
    );
  for (const row of evenlySample(leftovers, sampleSize - selected.length)) {
    if (selected.length >= sampleSize) break;
    if (!selectedIds.has(row.decisionId)) {
      selectedIds.add(row.decisionId);
      selected.push(row);
    }
  }
}

selected.sort(
  (left, right) =>
    left.marketGeneratedAt - right.marketGeneratedAt ||
    left.decisionId.localeCompare(right.decisionId),
);

if (selected.length === 0) {
  throw new Error('No finalized replay cases matched the campaign filters.');
}

const experimentConfig = {
  registry,
  decisionIds: selected.map((row) => row.decisionId),
  instructions,
};

const selectionManifest = {
  version: 'replay-campaign-selection-v1',
  generatedAt: Date.now(),
  paidExecutionApproved: false,
  requestedSampleSize: sampleSize,
  selectedSampleSize: selected.length,
  sourceFilters: {
    decisionClasses,
    contextPackVersion,
    instructionVersion,
    analysisMode: sourceAnalysisMode,
    outcomeFinalized: true,
  },
  availableByDecision: Object.fromEntries(
    [...catalogs.entries()].map(([decision, rows]) => [decision, rows.length]),
  ),
  selectedByDecision: Object.fromEntries(
    decisionClasses.map((decision) => [
      decision,
      selected.filter((row) => row.decision === decision).length,
    ]),
  ),
  marketGeneratedAtRange:
    selected.length > 0
      ? {
          first: selected[0]?.marketGeneratedAt ?? null,
          last: selected.at(-1)?.marketGeneratedAt ?? null,
        }
      : null,
  cases: selected.map((row) => ({
    decisionId: row.decisionId,
    marketGeneratedAt: row.marketGeneratedAt,
    decision: row.decision,
    side: row.side,
    analysisMode: row.analysisMode,
    instructionVersion: row.instructionVersion,
    contextPackVersion: row.contextPackVersion,
    payloadSha256: row.payloadSha256,
  })),
  note: 'Selection uses metadata and outcome-finalization status only. Future outcome values are not used for case selection.',
};

await writeFile(
  `${outputPrefix}.experiment.json`,
  `${JSON.stringify(experimentConfig, null, 2)}\n`,
  'utf8',
);
await writeFile(
  `${outputPrefix}.selection.json`,
  `${JSON.stringify(selectionManifest, null, 2)}\n`,
  'utf8',
);

console.log(
  `Selected ${selected.length}/${sampleSize} finalized replay cases across ${decisionClasses.length} decision classes.`,
);
console.log(`Experiment config: ${outputPrefix}.experiment.json`);
console.log(`Selection manifest: ${outputPrefix}.selection.json`);
console.log(
  `Next no-cost step: npm run replay:batch:prepare -- ${outputPrefix}.experiment.json ${outputPrefix}.batch`,
);
console.log('No OpenAI API call was made.');
