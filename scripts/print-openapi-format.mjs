import { readFile } from 'node:fs/promises';
import prettier from 'prettier';

const file = 'worker/openapi/openapi.json';
const source = await readFile(file, 'utf8');
const config = (await prettier.resolveConfig(file)) ?? {};
const formatted = await prettier.format(source, { ...config, filepath: file });

console.log('OPENAPI_FORMAT_BEGIN');
console.log(Buffer.from(formatted, 'utf8').toString('base64'));
console.log('OPENAPI_FORMAT_END');
