import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import prettier from 'prettier';

const files = [
  'scripts/d1-migration-validate.mjs',
  'scripts/research-report.mjs',
  'tests/unit/worker.research-ops.test.ts',
  'worker/src/research-ops.ts',
];

console.log('RESEARCH_OPS_FORMAT_DIFF_BEGIN');
for (const [index, file] of files.entries()) {
  const source = await readFile(file, 'utf8');
  const config = (await prettier.resolveConfig(file)) ?? {};
  const formatted = await prettier.format(source, { ...config, filepath: file });
  const formattedFile = `/tmp/research-ops-format-${index}.txt`;
  await writeFile(formattedFile, formatted, 'utf8');
  const diff = spawnSync('diff', ['-u', file, formattedFile], {
    encoding: 'utf8',
  });
  console.log(`FILE:${file}`);
  console.log(diff.stdout || 'NO_DIFF');
}
console.log('RESEARCH_OPS_FORMAT_DIFF_END');
