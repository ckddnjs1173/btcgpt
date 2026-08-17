import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import {
  applyEvidenceAblation,
  EVIDENCE_ABLATION_PROFILES,
} from './evidence-ablation-lib.mjs';

const relayUrl = (process.env.RELAY_URL ?? '').replace(/\/$/, '');
const actionKey = process.env.ACTION_READ_KEY ?? '';
const configPath = process.argv[2];
const outputPrefix = process.argv[3] ?? 'replay-batch';

if (!relayUrl || !actionKey || !configPath) {
  console.error(
    'Usage: RELAY_URL=... ACTION_READ_KEY=... npm run replay:batch:prepare -- <experiment.json> [output-prefix]',
  );
  process.exit(2);
}

const config = JSON.parse(await readFile(configPath, 'utf8'));
const registry = config.registry;
const decisionIds = Array.isArray(config.decisionIds) ? config.decisionIds : [];
const instructions = String(config.instructions ?? '').trim();
const ablationProfile = registry?.evidenceProfile
  ? String(registry.evidenceProfile)
  : null;

if (!registry?.experimentId || !registry?.model || decisionIds.length === 0) {
  throw new Error(
    'registry.experimentId, registry.model and decisionIds are required.',
  );
}
if (!instructions) throw new Error('instructions are required.');
if (
  ablationProfile !== null &&
  !EVIDENCE_ABLATION_PROFILES.includes(ablationProfile)
)
  throw new Error(
    `registry.evidenceProfile must be one of: ${EVIDENCE_ABLATION_PROFILES.join(', ')}.`,
  );

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function relay(path, init = {}) {
  const response = await fetch(`${relayUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${actionKey}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Relay ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function outputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'outputVersion',
      'decision',
      'side',
      'confidenceBand',
      'planValidation',
      'entry',
      'stop',
      'targets',
      'triggerSummary',
      'invalidationSummary',
      'reasonTags',
      'counterThesisTags',
    ],
    properties: {
      outputVersion: { type: 'string', const: 'eval-output-v1' },
      decision: {
        type: 'string',
        enum: [
          'ENTER_NOW',
          'WAIT_TRIGGER',
          'NO_TRADE',
          'HOLD',
          'PARTIAL_EXIT',
          'EXIT',
          'MOVE_STOP',
          'CHANGE_TP',
          'DATA_BLOCKED',
        ],
      },
      side: { type: 'string', enum: ['LONG', 'SHORT', 'NEUTRAL'] },
      confidenceBand: {
        type: 'string',
        enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'],
      },
      planValidation: {
        type: 'string',
        enum: ['NOT_APPLICABLE', 'NOT_RUN', 'VALIDATED', 'BLOCKED'],
      },
      entry: { type: ['number', 'null'] },
      stop: { type: ['number', 'null'] },
      targets: {
        type: 'array',
        maxItems: 3,
        items: { type: 'number' },
      },
      triggerSummary: { type: ['string', 'null'], maxLength: 300 },
      invalidationSummary: { type: ['string', 'null'], maxLength: 300 },
      reasonTags: {
        type: 'array',
        maxItems: 12,
        items: { type: 'string', maxLength: 60 },
      },
      counterThesisTags: {
        type: 'array',
        maxItems: 8,
        items: { type: 'string', maxLength: 60 },
      },
    },
  };
}

function responseBody(replayInput) {
  return {
    model: registry.model,
    store: false,
    instructions,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              'Judge this frozen historical BTC futures market state.',
              'Use only the supplied replay input. Do not use web search, current knowledge, or future outcomes.',
              `Analysis mode: ${registry.analysisMode}.`,
              ablationProfile
                ? `Evidence ablation profile: ${ablationProfile}. Missing evidence in this input is intentional; do not reconstruct it from outside knowledge.`
                : null,
              'Return only the requested structured decision.',
              JSON.stringify(replayInput),
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'btc_replay_decision',
        strict: true,
        schema: outputSchema(),
      },
    },
  };
}

const promptHash = sha256(instructions).slice(0, 16);
const baseInstructionVersion = String(
  registry.instructionVersion ?? 'replay-instructions',
);
const registered = {
  ...registry,
  provider: 'OPENAI',
  instructionVersion: `${baseInstructionVersion}@${promptHash}`.slice(0, 120),
};
delete registered.evidenceProfile;
await relay('/v1/replay/experiment/register', {
  method: 'POST',
  body: JSON.stringify(registered),
});

const lines = [];
const manifest = {
  version: 'openai-replay-batch-manifest-v1',
  experimentId: registry.experimentId,
  model: registry.model,
  preparedAt: Date.now(),
  paidExecutionApproved: false,
  evidenceProfile: ablationProfile,
  ablationBasis:
    ablationProfile === null
      ? 'NONE'
      : 'FROZEN_DECISION_CONTEXT_FIELD_REMOVAL_ONLY',
  items: [],
};

for (const [index, decisionId] of decisionIds.entries()) {
  const originalReplayInput = await relay(
    `/v1/replay/case/${encodeURIComponent(decisionId)}/input`,
  );
  const ablation = ablationProfile
    ? applyEvidenceAblation(originalReplayInput, ablationProfile)
    : {
        replayInput: originalReplayInput,
        applied: false,
        profile: null,
        reason: null,
      };
  if (ablationProfile && !ablation.applied)
    throw new Error(
      `Decision ${decisionId} cannot use evidence profile ${ablationProfile}: ${ablation.reason}. Select Decision Context replay cases only.`,
    );
  const replayInput = ablation.replayInput;
  const customId = `${registry.experimentId}-${index + 1}`;
  const runId = `${registry.experimentId}-${index + 1}-${randomUUID().slice(0, 8)}`;
  lines.push(
    JSON.stringify({
      custom_id: customId,
      method: 'POST',
      url: '/v1/responses',
      body: responseBody(replayInput),
    }),
  );
  manifest.items.push({
    customId,
    runId,
    decisionId,
    trialIndex: 1,
    evidenceProfile: ablationProfile,
    ablationApplied: ablation.applied,
  });
}

await writeFile(`${outputPrefix}.jsonl`, `${lines.join('\n')}\n`, 'utf8');
await writeFile(
  `${outputPrefix}.manifest.json`,
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

console.log(`Prepared ${lines.length} replay requests.`);
console.log(`Batch file: ${outputPrefix}.jsonl`);
console.log(`Manifest: ${outputPrefix}.manifest.json`);
if (ablationProfile)
  console.log(
    `Applied ${ablationProfile} only to frozen Decision Context fields; no future outcome was used.`,
  );
console.log(
  'No OpenAI API call was made. Upload/execute the batch only after explicit paid-API approval.',
);