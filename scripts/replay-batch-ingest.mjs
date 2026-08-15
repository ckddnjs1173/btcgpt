import { readFile } from 'node:fs/promises';

const relayUrl = (process.env.RELAY_URL ?? '').replace(/\/$/, '');
const actionKey = process.env.ACTION_READ_KEY ?? '';
const manifestPath = process.argv[2];
const outputPath = process.argv[3];

if (!relayUrl || !actionKey || !manifestPath || !outputPath) {
  console.error(
    'Usage: RELAY_URL=... ACTION_READ_KEY=... npm run replay:batch:ingest -- <manifest.json> <batch-output.jsonl>',
  );
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const outputLines = (await readFile(outputPath, 'utf8'))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const manifestByCustomId = new Map(
  (manifest.items ?? []).map((item) => [item.customId, item]),
);

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

function extractOutputText(responseBody) {
  for (const item of responseBody?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        return content.text;
      }
    }
  }
  throw new Error('Responses batch item did not contain output_text.');
}

let ingested = 0;
let skipped = 0;
for (const line of outputLines) {
  const item = manifestByCustomId.get(line.custom_id);
  if (!item) {
    skipped += 1;
    console.warn(`Skipping unknown custom_id: ${line.custom_id}`);
    continue;
  }
  if (line.error || line.response?.status_code >= 400) {
    skipped += 1;
    console.warn(
      `Skipping failed batch item ${line.custom_id}: ${JSON.stringify(line.error ?? line.response)}`,
    );
    continue;
  }

  const responseBody = line.response?.body;
  const parsed = JSON.parse(extractOutputText(responseBody));
  const usage = responseBody?.usage ?? {};
  await relay('/v1/replay/run/start', {
    method: 'POST',
    body: JSON.stringify({
      runId: item.runId,
      experimentId: manifest.experimentId,
      decisionId: item.decisionId,
      trialIndex: item.trialIndex ?? 1,
    }),
  });
  await relay(`/v1/replay/run/${encodeURIComponent(item.runId)}/output`, {
    method: 'POST',
    body: JSON.stringify({
      ...parsed,
      providerResponseId: responseBody?.id ?? null,
      latencyMs: null,
      usage: {
        inputTokens: usage.input_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? null,
        reportedCostUsd: null,
        costBasis: 'UNKNOWN',
      },
    }),
  });
  ingested += 1;
  console.log(`${item.decisionId}: ${parsed.decision}/${parsed.side}`);
}

console.log(`Ingested ${ingested} batch outputs; skipped ${skipped}.`);
console.log(
  `Benchmark: GET ${relayUrl}/v1/research/benchmark/${encodeURIComponent(manifest.experimentId)}`,
);
