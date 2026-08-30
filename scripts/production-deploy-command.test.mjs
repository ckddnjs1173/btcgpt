import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { resolveNpmInvocation } from './production-deploy-command.mjs';

test('uses node plus npm_execpath on Windows instead of spawning npm.cmd directly', () => {
  const invocation = resolveNpmInvocation({
    platform: 'win32',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    npmExecPath:
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  });

  assert.equal(invocation.executable, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(invocation.prefixArgs, [
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
  ]);
  assert.equal(invocation.strategy, 'NODE_NPM_CLI');
  assert.notEqual(invocation.executable.toLowerCase(), 'npm.cmd');
});

test('falls back to cmd.exe on Windows when npm_execpath is unavailable', () => {
  const invocation = resolveNpmInvocation({
    platform: 'win32',
    nodeExecutable: 'node.exe',
    npmExecPath: '',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  });

  assert.equal(invocation.executable, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.prefixArgs, ['/d', '/s', '/c', 'npm']);
  assert.equal(invocation.strategy, 'WINDOWS_CMD_FALLBACK');
});

test('uses npm from PATH on non-Windows fallback', () => {
  const invocation = resolveNpmInvocation({
    platform: 'linux',
    nodeExecutable: '/usr/bin/node',
    npmExecPath: '',
    comspec: '',
  });

  assert.equal(invocation.executable, 'npm');
  assert.deepEqual(invocation.prefixArgs, []);
  assert.equal(invocation.strategy, 'PATH_NPM');
});

test('production preflight reuses the Windows-safe npm invocation resolver', () => {
  const preflight = fs.readFileSync(
    new URL('./production-preflight.mjs', import.meta.url),
    'utf8',
  );

  assert.match(preflight, /resolveNpmInvocation\(\)/);
  assert.doesNotMatch(preflight, /['"]npm\.cmd['"]/);
});
