const fs = require('node:fs');
function edit(path, before, after) {
  const source = fs.readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`missing ${path}`);
  fs.writeFileSync(path, source.replace(before, after));
}
const ipc='src/main/ipc/register-handlers.ts';
const block=`      const existingPlan = database.readActiveLockedTradePlan(
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
edit(ipc,block,'');
edit(ipc,`      database.saveLockedTradePlan(plan);
      return plan;`,`      const existingPlan = database.readActiveLockedTradePlan(settings.tradingMode);
      if (existingPlan?.status === 'LOCKED') {
        const now = Date.now();
        database.saveLockedTradePlan({
          ...existingPlan,
          status: 'CANCELLED',
          monitoring: existingPlan.monitoring
            ? { ...existingPlan.monitoring, state: 'CANCELLED', cancelledAt: now }
            : existingPlan.monitoring,
        });
      } else if (existingPlan) {
        throw new Error('ACTIVE_TRADE_PLAN_EXISTS');
      }
      database.saveLockedTradePlan(plan);
      return plan;`);
console.log('phase12 fixup complete');
