import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const relayUrl = (process.env.RELAY_URL ?? '').replace(/\/$/, '');
const actionKey = process.env.ACTION_READ_KEY ?? '';
const configPath = process.argv[2];

if (!relayUrl || !actionKey || !configPath) {
  console.error(
    'Usage: RELAY_URL=... ACTION_READ_KEY=... npm run replay:run -- <experiment.json>',
  );
  process.exit(2);
}

const config = JSON.parse(await readFile(configPath, 'utf8'));
const registry = config.registry;
const decisionIds = Array.isArray(config.decisionIds) ? config.decisionIds : [];
const instructions = String(config.instructions ?? '').trim();
const provider = String(config.provider ?? 'MANUAL').toUpperCase();

if (!registry || !registry.experimentId || decisionIds.length === 0) {
  throw new Error('Experiment registry config and at least one decisionId are required.');
}

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
    const error = new Error(`Relay ${response.status}: ${JSON.stringify(body)}`);
    error.status = response.status;
    error.body = body;
    throw error;
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

function extractOutputText(response) {
  for (const item of response.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        return content.text;
      }
    }
  }
  throw new Error('OpenAI response did not contain output_text.');
}

async function runOpenAI(replayInput) {
  if (process.env.ALLOW_PAID_REPLAY !== 'YES') {
    throw new Error(
      'Paid replay is disabled. Set ALLOW_PAID_REPLAY=YES only after explicit cost approval.',
    );
  }
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for OPENAI replay.');
  if (!instructions) throw new Error('instructions are required for OPENAI replay.');

  const startedAt = Date.now();
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-client-request-id': randomUUID(),
    },
    body: JSON.stringify({
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
                'Return only the requested structured decision.',
                JSON.stringify(replayInput),
              ].join('\n\n'),
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
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${JSON.stringify(body)}`);
  }
  const parsed = JSON.parse(extractOutputText(body));
  const usage = body.usage ?? {};
  return {
    ...parsed,
    providerResponseId: body.id ?? null,
    latencyMs: Date.now() - startedAt,
    usage: {
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? null,
      reportedCostUsd: null,
      costBasis: 'UNKNOWN',
    },
  };
}

async function registerExperiment() {
  const registered = {
    ...registry,
    instructionVersion:
      registry.instructionVersion || `sha256:${sha256(instructions).slice(0, 16)}`,
  };
  return relay('/v1/replay/experiment/register', {
    method: 'POST',
    body: JSON.stringify(registered),
  });
}

async function main() {
  const registration = await registerExperiment();
  console.log(
    `Experiment ${registry.experimentId} registered (${registration.configSha256}).`,
  );

  if (provider !== 'OPENAI') {
    console.log(
      'Provider is MANUAL. No model calls will be made. Set provider=OPENAI plus explicit paid-replay approval to execute automated replays.',
    );
    return;
  }

  for (const [index, decisionId] of decisionIds.entries()) {
    const replayInput = await relay(
      `/v1/replay/case/${encodeURIComponent(decisionId)}/input`,
    );
    const runId = `${registry.experimentId}-${index + 1}-${randomUUID().slice(0, 8)}`;
    await relay('/v1/replay/run/start', {
      method: 'POST',
      body: JSON.stringify({
        runId,
        experimentId: registry.experimentId,
        decisionId,
        trialIndex: 1,
      }),
    });
    const output = await runOpenAI(replayInput);
    await relay(`/v1/replay/run/${encodeURIComponent(runId)}/output`, {
      method: 'POST',
      body: JSON.stringify(output),
    });
    console.log(`${decisionId}: ${output.decision}/${output.side}`);
  }

  const summary = await relay(
    `/v1/replay/experiment/${encodeURIComponent(registry.experimentId)}/summary`,
  );
  console.log(JSON.stringify(summary, null, 2));
}

await main();
