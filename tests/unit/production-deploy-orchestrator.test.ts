import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('production deploy orchestrator', () => {
  const raw = fs.readFileSync(
    path.join(process.cwd(), 'scripts', 'production-deploy.mjs'),
    'utf8',
  );

  it('defaults to read-only and requires explicit apply confirmation', () => {
    expect(raw).toContain("const APPLY_FLAG = '--apply'");
    expect(raw).toContain(
      "const EXPECTED_CONFIRMATION = 'btc-futures-assistant-relay'",
    );
    expect(raw).toContain("Mode: ${apply ? 'APPLY' : 'READ_ONLY_PLAN'}");
    expect(raw).toContain(
      'READ_ONLY_PLAN completed. Production was not changed.',
    );
    expect(raw).toContain('Refusing production changes.');
  });

  it('uses the cross-platform npm invocation resolver instead of npm.cmd', () => {
    expect(raw).toContain("from './production-deploy-command.mjs'");
    expect(raw).toContain('resolveNpmInvocation()');
    expect(raw).not.toContain("'npm.cmd'");
  });

  it('runs preflight and dry-run before remote mutation, then smoke after deploy', () => {
    const preflight = raw.indexOf("npm(['run', 'ops:preflight'])");
    const dryRun = raw.indexOf("'--dry-run'");
    const migrationApply = raw.indexOf("'apply',\n  DATABASE,\n  '--remote'");
    const strictDeploy = raw.indexOf("'--strict'");
    const smoke = raw.indexOf("npm(['run', 'ops:postdeploy-smoke'");

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(dryRun).toBeGreaterThan(preflight);
    expect(migrationApply).toBeGreaterThan(dryRun);
    expect(strictDeploy).toBeGreaterThan(migrationApply);
    expect(smoke).toBeGreaterThan(strictDeploy);
    expect(raw).toContain(
      'already-applied D1 migrations are not automatically rolled back',
    );
  });
});
