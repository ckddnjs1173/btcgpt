import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import prettier from 'prettier';

const files = [
  'scripts/replay-batch-prepare.mjs',
  'tests/unit/worker.phase24-25-research.test.ts',
  'worker/src/phase24-25-research.ts',
];

console.log('PHASE25_FORMAT_DIFF_BEGIN');
for (const [index, file] of files.entries()) {
  const source = await readFile(file, 'utf8');
  const config = (await prettier.resolveConfig(file)) ?? {};
  const formatted = await prettier.format(source, { ...config, filepath: file });
  const formattedFile = `/tmp/phase25-format-${index}.txt`;
  await writeFile(formattedFile, formatted, 'utf8');
  const diff = spawnSync('diff', ['-u', file, formattedFile], {
    encoding: 'utf8',
  });
  console.log(`FILE:${file}`);
  console.log(diff.stdout || 'NO_DIFF');
}
console.log('PHASE25_FORMAT_DIFF_END');
