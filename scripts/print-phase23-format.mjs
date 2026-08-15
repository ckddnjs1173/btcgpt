import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import prettier from 'prettier';

const files = [
  'tests/unit/worker.memory-reasoning-management.test.ts',
  'worker/src/phase21-memory.ts',
  'worker/src/phase22-reasoning.ts',
  'worker/src/phase23-management.ts',
];

console.log('PHASE23_FORMAT_DIFF_BEGIN');
for (const [index, file] of files.entries()) {
  const source = await readFile(file, 'utf8');
  const config = (await prettier.resolveConfig(file)) ?? {};
  const formatted = await prettier.format(source, { ...config, filepath: file });
  const formattedFile = `/tmp/phase23-format-${index}.txt`;
  await writeFile(formattedFile, formatted, 'utf8');
  const diff = spawnSync('diff', ['-u', file, formattedFile], {
    encoding: 'utf8',
  });
  console.log(`FILE:${file}`);
  console.log(diff.stdout || 'NO_DIFF');
}
console.log('PHASE23_FORMAT_DIFF_END');
