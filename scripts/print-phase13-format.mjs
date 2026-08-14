import { readFile } from 'node:fs/promises';
import prettier from 'prettier';

const files = [
  'tests/unit/worker.phase13.test.ts',
  'worker/openapi/decision-telemetry.openapi.json',
  'worker/src/phase13.ts',
];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const config = (await prettier.resolveConfig(file)) ?? {};
  const formatted = await prettier.format(source, { ...config, filepath: file });
  console.log(`PHASE13_FORMAT_BEGIN:${file}`);
  console.log(Buffer.from(formatted, 'utf8').toString('base64'));
  console.log(`PHASE13_FORMAT_END:${file}`);
}
