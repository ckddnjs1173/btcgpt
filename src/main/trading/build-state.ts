import type { AccountStatus, TradingState } from '../../shared/contracts';
import type { AppDatabase } from '../db/database';

const ACCOUNT_STALE_MS = 45_000;

export function buildTradingState(
  database: AppDatabase,
  account: AccountStatus,
  now = Date.now(),
): TradingState {
  const settings = database.readUserSettings();
  const plan = database.readActiveLockedTradePlan(settings.tradingMode);
  const paperTrade = database.readActivePaperTrade();
  const latestPaperTrade = database.readLatestPaperTrade();
  const lastCompletedPaperTrade =
    latestPaperTrade?.status === 'CLOSED' ? latestPaperTrade : null;
  const blockedReasons: string[] = [];

  if (!account.connected) blockedReasons.push('ACCOUNT_NOT_CONNECTED');
  if (!account.position) blockedReasons.push('NO_LIVE_POSITION');
  if (
    account.lastUpdatedAt === null ||
    now - account.lastUpdatedAt > ACCOUNT_STALE_MS
  )
    blockedReasons.push('ACCOUNT_DATA_STALE');

  const protectiveOrders = account.openOrders.filter(
    (order) => order.protective,
  );
  const planMatchesPosition =
    plan && account.position
      ? plan.side === account.position.side &&
        Math.abs(plan.quantity - account.position.quantity) < 1e-8 &&
        plan.leverage === account.position.leverage
      : null;

  if (planMatchesPosition === false)
    blockedReasons.push('LIVE_POSITION_DIFFERS_FROM_LOCKED_PLAN');

  const lifecycleStage =
    paperTrade || account.position
      ? ('MANAGING' as const)
      : plan?.status === 'ENTERED'
        ? ('ENTRY_READY' as const)
        : plan?.status === 'LOCKED'
          ? ('WATCHING' as const)
          : lastCompletedPaperTrade
            ? ('CLOSED' as const)
            : ('FLAT' as const);

  return {
    mode: settings.tradingMode,
    lifecycle: {
      stage: lifecycleStage,
      mode: settings.tradingMode,
      planId: plan?.id ?? paperTrade?.planId ?? null,
      tradeId: paperTrade?.id ?? lastCompletedPaperTrade?.id ?? null,
      positionSource: paperTrade
        ? 'PAPER'
        : account.position
          ? 'BINANCE_READ_ONLY'
          : 'NONE',
      startedAt:
        paperTrade?.openedAt ??
        account.position?.updatedAt ??
        plan?.lockedAt ??
        lastCompletedPaperTrade?.openedAt ??
        null,
      updatedAt:
        paperTrade?.updatedAt ??
        account.position?.updatedAt ??
        plan?.lockedAt ??
        lastCompletedPaperTrade?.updatedAt ??
        now,
      blockedReasons:
        lifecycleStage === 'MANAGING' && account.position
          ? blockedReasons
          : [],
    },
    activePlan: plan,
    activePaperTrade: paperTrade,
    lastCompletedPaperTrade,
    statistics: database.readTradingStatistics(),
    liveManual: {
      available: blockedReasons.length === 0,
      blockedReasons,
      position: account.position,
      protectiveOrders,
      recentTrades: account.recentTrades,
      realizedPnl:
        account.recentTrades.length > 0
          ? account.recentTrades.reduce(
              (sum, trade) => sum + trade.realizedPnl - trade.commission,
              0,
            )
          : null,
      planMatchesPosition,
    },
  };
}
