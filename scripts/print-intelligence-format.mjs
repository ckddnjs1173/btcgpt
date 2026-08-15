import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import prettier from 'prettier';

const files = [
  'scripts/replay-runner.mjs',
  'worker/src/phase17-cross-market.ts',
  'worker/src/phase20-context-router.ts',
  'worker/src/phase20.ts',
];

console.log('INTELLIGENCE_FORMAT_DIFF_BEGIN');
for (const [index, file] of files.entries()) {
  const source = await readFile(file, 'utf8');
  const config = (await prettier.resolveConfig(file)) ?? {};
  const formatted = await prettier.format(source, { ...config, filepath: file });
  const formattedFile = `/tmp/intelligence-format-${index}.txt`;
  await writeFile(formattedFile, formatted, 'utf8');
  const diff = spawnSync('diff', ['-u', file, formattedFile], {
    encoding: 'utf8',
  });
  console.log(`FILE:${file}`);
  console.log(diff.stdout || 'NO_DIFF');
}
console.log('INTELLIGENCE_FORMAT_DIFF_END');
