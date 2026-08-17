import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { EVIDENCE_ABLATION_PROFILES } from './evidence-ablation-lib.mjs';

const sourcePath = process.argv[2];
const outputDir = process.argv[3] ?? 'research/ablation-campaign';

if (!sourcePath) {
  console.error(
    'Usage: npm run research:ablation:prepare -- <base-experiment.json> [output-dir]',
  );
  process.exit(2);
}

const source = JSON.parse(await readFile(sourcePath, 'utf8'));
const registry = source.registry ?? {};
const decisionIds = Array.isArray(source.decisionIds)
  ? source.decisionIds.map(String)
  : [];
const instructions = String(source.instructions ?? '').trim();

if (!registry.experimentId || !registry.name || !registry.model) {
  throw new Error(
    'The base experiment must include registry.experimentId, registry.name and registry.model.',
  );
}
if (decisionIds.length === 0)
  throw new Error('The base experiment must include at least one decisionId.');
if (!instructions) throw new Error('The base experiment instructions are empty.');

const profileSources = {
  BASELINE: [],
  LEAD_CORE: ['ETH_SOL_LEAD_CORE'],
  ALT_BREADTH: ['ETH_SOL_LEAD_CORE', 'ALT_MARKET_BREADTH'],
  COINBASE: ['ETH_SOL_LEAD_CORE', 'ALT_MARKET_BREADTH', 'COINBASE_SPOT'],
  OPTIONS_V2: [
    'ETH_SOL_LEAD_CORE',
    'ALT_MARKET_BREADTH',
    'COINBASE_SPOT',
    'DERIBIT_OPTIONS_V2',
  ],
  ONCHAIN_V1: [
    'ETH_SOL_LEAD_CORE',
    'ALT_MARKET_BREADTH',
    'COINBASE_SPOT',
    'DERIBIT_OPTIONS_V2',
    'ONCHAIN_V1',
  ],
};

await mkdir(outputDir, { recursive: true });
const manifest = {
  version: 'evidence-ablation-campaign-v1',
  generatedAt: Date.now(),
  sourceExperimentId: registry.experimentId,
  decisionIds,
  caseCount: decisionIds.length,
  profiles: [],
  paidExecutionApproved: false,
  selectionInvariant: true,
  note: 'Every profile uses the exact same frozen decision IDs and instructions. Only approved Decision Context evidence fields are removed cumulatively. No future outcome is used during preparation.',
};

for (const [index, profile] of EVIDENCE_ABLATION_PROFILES.entries()) {
  const slug = profile.toLowerCase().replaceAll('_', '-');
  const experimentId = `${registry.experimentId}-abl-${index}-${slug}`.slice(
    0,
    120,
  );
  const config = {
    ...source,
    registry: {
      ...registry,
      experimentId,
      name: `${registry.name} / ${profile}`.slice(0, 160),
      evidenceProfile: profile,
      enabledSources: profileSources[profile],
    },
    decisionIds: [...decisionIds],
    instructions,
  };
  const file = path.join(outputDir, `${String(index).padStart(2, '0')}-${slug}.experiment.json`);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  manifest.profiles.push({
    order: index,
    profile,
    experimentId,
    enabledSources: profileSources[profile],
    file,
  });
}

const manifestPath = path.join(outputDir, 'campaign-manifest.json');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(
  `Prepared ${manifest.profiles.length} matched evidence-ablation experiments with ${decisionIds.length} frozen cases each.`,
);
console.log(`Manifest: ${manifestPath}`);
console.log(
  'No OpenAI API call was made. Each experiment still requires replay:batch:prepare and explicit paid execution approval.',
);