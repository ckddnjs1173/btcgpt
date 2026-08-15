import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import prettier from 'prettier';

const file = 'worker/src/phase13-lineage.ts';
const formattedFile = '/tmp/phase13-lineage.formatted.ts';
const source = await readFile(file, 'utf8');
const config = (await prettier.resolveConfig(file)) ?? {};
const formatted = await prettier.format(source, { ...config, filepath: file });
await writeFile(formattedFile, formatted, 'utf8');
const diff = spawnSync('diff', ['-u', file, formattedFile], { encoding: 'utf8' });
console.log('PHASE13B_FORMAT_DIFF_BEGIN');
console.log(diff.stdout || 'NO_DIFF');
console.log('PHASE13B_FORMAT_DIFF_END');
