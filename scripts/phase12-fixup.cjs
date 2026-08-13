const fs = require('node:fs');
const { execSync } = require('node:child_process');

function edit(path, before, after) {
  const source = fs.readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`missing ${path}`);
  fs.writeFileSync(path, source.replace(before, after));
}

const ipc = 'src/main/ipc/register-handlers.ts';
const earlyCancellation = `      const existingPlan = database.readActiveLockedTradePlan(
        settings.tradingMode,
      );
      if (existingPlan?.status === 'LOCKED') {
        const now = Date.now();
        database.saveLockedTradePlan({
          ...existingPlan,
          status: 'CANCELLED',
          monitoring: existingPlan.monitoring
            ? {
                ...existingPlan.monitoring,
                state: 'CANCELLED',
                cancelledAt: now,
              }
            : existingPlan.monitoring,
        });
      } else if (existingPlan) {
        throw new Error('ACTIVE_TRADE_PLAN_EXISTS');
      }
`;
edit(ipc, earlyCancellation, '');
edit(
  ipc,
  `      return database.saveLockedTradePlan(plan);`,
  `      const existingPlan = database.readActiveLockedTradePlan(
        settings.tradingMode,
      );
      if (existingPlan?.status === 'LOCKED') {
        const now = Date.now();
        database.saveLockedTradePlan({
          ...existingPlan,
          status: 'CANCELLED',
          monitoring: existingPlan.monitoring
            ? {
                ...existingPlan.monitoring,
                state: 'CANCELLED',
                cancelledAt: now,
              }
            : existingPlan.monitoring,
        });
      } else if (existingPlan) {
        throw new Error('ACTIVE_TRADE_PLAN_EXISTS');
      }
      return database.saveLockedTradePlan(plan);`,
);

execSync('npx prettier --write src/main/ipc/register-handlers.ts', {
  stdio: 'inherit',
});
execSync('git config user.name "github-actions[bot]"');
execSync(
  'git config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
);
execSync('git add src/main/ipc/register-handlers.ts');
execSync('git commit -m "fix: preserve existing plan until replacement validates"', {
  stdio: 'inherit',
});
execSync('git push origin HEAD:finalize-phase12', { stdio: 'inherit' });
