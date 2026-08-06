import { randomUUID } from 'node:crypto';

import type {
  AccountStatus,
  LiveTradeAttribution,
  LiveTradeSession,
  LockedTradePlan,
  ProtectiveCoverage,
  TradingState,
} from '../../shared/contracts';
import type { AppDatabase } from '../db/database';

const ACCOUNT_STALE_MS = 45_000;
const QUANTITY_EPSILON = 1e-8;

type AccountTrade = AccountStatus['recentTrades'][number];
type AccountPosition = NonNullable<AccountStatus['position']>;

function tradeSignedQuantity(trade: AccountTrade): number {
  return trade.side === 'BUY' ? trade.quantity : -trade.quantity;
}

function isTradeForSide(
  trade: AccountTrade,
  side: AccountPosition['side'],
): boolean {
  return trade.positionSide === 'BOTH' || trade.positionSide === side;
}

function inferLiveTradeStart(
  position: AccountPosition,
  trades: AccountStatus['recentTrades'],
  now: number,
): {
  openedAt: number;
  attribution: LiveTradeAttribution;
} {
  const compatible = trades
    .filter((trade) => isTradeForSide(trade, position.side))
    .sort((left, right) => right.timestamp - left.timestamp);
  let cursor = position.side === 'LONG' ? position.quantity : -position.quantity;

  for (const trade of compatible) {
    const previous = cursor - tradeSignedQuantity(trade);
    const returnedToFlat = Math.abs(previous) <= QUANTITY_EPSILON;
    const crossedThroughFlat =
      position.side === 'LONG'
        ? previous < -QUANTITY_EPSILON
        : previous > QUANTITY_EPSILON;
    if (returnedToFlat || crossedThroughFlat) {
      return {
        openedAt: trade.timestamp,
        attribution: returnedToFlat
          ? 'OBSERVED_FROM_FLAT'
          : 'INFERRED_FROM_RECENT_TRADES',
      };
    }
    cursor = previous;
  }

  const earliestCompatible = compatible.at(-1)?.timestamp;
  return {
    openedAt:
      earliestCompatible ??
      (position.updatedAt > 0 ? position.updatedAt : now),
    attribution: 'OBSERVED_AFTER_CONNECT',
  };
}

function mergeTradeAccounting(
  session: LiveTradeSession,
  trades: AccountStatus['recentTrades'],
): Pick<
  LiveTradeSession,
  | 'observedTradeIds'
  | 'realizedGrossPnl'
  | 'commissionByAsset'
  | 'feesPaid'
  | 'realizedNetPnl'
> {
  const observed = new Set(session.observedTradeIds);
  const commissionByAsset = { ...session.commissionByAsset };
  let realizedGrossPnl = session.realizedGrossPnl;

  for (const trade of trades) {
    if (
      trade.timestamp < session.openedAt ||
      !isTradeForSide(trade, session.side) ||
      observed.has(trade.tradeId)
    )
      continue;
    observed.add(trade.tradeId);
    realizedGrossPnl += trade.realizedPnl;
    const asset = trade.commissionAsset.toUpperCase();
    commissionByAsset[asset] =
      (commissionByAsset[asset] ?? 0) + Math.abs(trade.commission);
  }

  const commissionAssets = Object.keys(commissionByAsset).filter(
    (asset) => Math.abs(commissionByAsset[asset] ?? 0) > 0,
  );
  const completeAttribution = session.attribution === 'OBSERVED_FROM_FLAT';
  const feesPaid =
    completeAttribution &&
    commissionAssets.every((asset) => asset === 'USDT')
      ? (commissionByAsset.USDT ?? 0)
      : null;

  return {
    observedTradeIds: [...observed],
    realizedGrossPnl,
    commissionByAsset,
    feesPaid,
    realizedNetPnl:
      feesPaid === null ? null : realizedGrossPnl - feesPaid,
  };
}

function createLiveTradeSession(
  position: AccountPosition,
  recentTrades: AccountStatus['recentTrades'],
  plan: LockedTradePlan | null,
  now: number,
): LiveTradeSession {
  const inferred = inferLiveTradeStart(position, recentTrades, now);
  const session: LiveTradeSession = {
    id: randomUUID(),
    planId:
      plan &&
      plan.side === position.side &&
      plan.leverage === position.leverage
        ? plan.id
        : null,
    status: 'OPEN',
    side: position.side,
    entryPrice: position.entryPrice,
    initialQuantity: position.quantity,
    peakQuantity: position.quantity,
    remainingQuantity: position.quantity,
    leverage: position.leverage,
    isolatedMargin: position.isolatedMargin,
    openedAt: inferred.openedAt,
    closedAt: null,
    realizedGrossPnl: 0,
    feesPaid: inferred.attribution === 'OBSERVED_FROM_FLAT' ? 0 : null,
    commissionByAsset: {},
    realizedNetPnl:
      inferred.attribution === 'OBSERVED_FROM_FLAT' ? 0 : null,
    unrealizedPnl: position.unrealizedPnl,
    lastMarkPrice: position.markPrice,
    observedTradeIds: [],
    attribution: inferred.attribution,
    updatedAt: now,
  };
  return {
    ...session,
    ...mergeTradeAccounting(session, recentTrades),
  };
}

function updateLiveTradeSession(
  session: LiveTradeSession,
  position: AccountPosition | null,
  recentTrades: AccountStatus['recentTrades'],
  now: number,
): LiveTradeSession {
  const accounting = mergeTradeAccounting(session, recentTrades);
  const remainingQuantity = position?.quantity ?? 0;
  const peakQuantity = Math.max(session.peakQuantity, remainingQuantity);
  const closed = position === null;
  const partiallyClosed =
    !closed &&
    (remainingQuantity + QUANTITY_EPSILON < peakQuantity ||
      Math.abs(accounting.realizedGrossPnl) > QUANTITY_EPSILON);

  return {
    ...session,
    ...accounting,
    status: closed
      ? 'CLOSED'
      : partiallyClosed
        ? 'PARTIALLY_CLOSED'
        : 'OPEN',
    entryPrice: position?.entryPrice ?? session.entryPrice,
    peakQuantity,
    remainingQuantity,
    leverage: position?.leverage ?? session.leverage,
    isolatedMargin: position?.isolatedMargin ?? session.isolatedMargin,
    closedAt: closed ? now : null,
    unrealizedPnl: position?.unrealizedPnl ?? 0,
    lastMarkPrice: position?.markPrice ?? session.lastMarkPrice,
    updatedAt: now,
  };
}

function syncLiveTradeSessions(
  database: AppDatabase,
  account: AccountStatus,
  plan: LockedTradePlan | null,
  now: number,
): {
  active: LiveTradeSession | null;
  lastCompleted: LiveTradeSession | null;
} {
  let active = database.readActiveLiveTrade();
  let lastCompleted = (() => {
    const latest = database.readLatestLiveTrade();
    return latest?.status === 'CLOSED' ? latest : null;
  })();
  const fresh =
    account.connected &&
    account.lastUpdatedAt !== null &&
    now - account.lastUpdatedAt <= ACCOUNT_STALE_MS;

  if (!fresh) return { active, lastCompleted };

  if (active && account.position && active.side !== account.position.side) {
    const closed = updateLiveTradeSession(
      active,
      null,
      account.recentTrades,
      now,
    );
    database.saveLiveTradeSession(closed);
    lastCompleted = closed;
    active = null;
  }

  if (account.position) {
    active =
      active ??
      createLiveTradeSession(account.position, account.recentTrades, plan, now);
    active = updateLiveTradeSession(
      active,
      account.position,
      account.recentTrades,
      now,
    );
    database.saveLiveTradeSession(active);
    return { active, lastCompleted };
  }

  if (active) {
    const closed = updateLiveTradeSession(
      active,
      null,
      account.recentTrades,
      now,
    );
    database.saveLiveTradeSession(closed);
    return { active: null, lastCompleted: closed };
  }

  return { active: null, lastCompleted };
}

function buildProtectiveCoverage(
  position: AccountStatus['position'],
  orders: AccountStatus['openOrders'],
): ProtectiveCoverage {
  if (!position)
    return {
      stopLossQuantity: 0,
      takeProfitQuantity: 0,
      stopLossCoverageRatio: null,
      takeProfitCoverageRatio: null,
      hasFullStopCoverage: false,
      hasFullTakeProfitCoverage: false,
    };

  const closingSide = position.side === 'LONG' ? 'SELL' : 'BUY';
  const protective = orders.filter(
    (order) => order.protective && order.side === closingSide,
  );
  const orderQuantity = (order: (typeof protective)[number]) =>
    order.closePosition ? position.quantity : order.quantity;
  const stopLossQuantity = protective
    .filter(
      (order) =>
        order.type.includes('STOP') &&
        !order.type.includes('TAKE_PROFIT'),
    )
    .reduce((sum, order) => sum + orderQuantity(order), 0);
  const takeProfitQuantity = protective
    .filter((order) => order.type.includes('TAKE_PROFIT'))
    .reduce((sum, order) => sum + orderQuantity(order), 0);
  const stopLossCoverageRatio = stopLossQuantity / position.quantity;
  const takeProfitCoverageRatio = takeProfitQuantity / position.quantity;

  return {
    stopLossQuantity,
    takeProfitQuantity,
    stopLossCoverageRatio,
    takeProfitCoverageRatio,
    hasFullStopCoverage: stopLossCoverageRatio >= 1 - QUANTITY_EPSILON,
    hasFullTakeProfitCoverage:
      takeProfitCoverageRatio >= 1 - QUANTITY_EPSILON,
  };
}

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
  const liveTrades = syncLiveTradeSessions(database, account, plan, now);
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
  const protectiveCoverage = buildProtectiveCoverage(
    account.position,
    protectiveOrders,
  );
  const planMatchesPosition =
    plan && account.position
      ? plan.side === account.position.side &&
        Math.abs(plan.quantity - account.position.quantity) <
          QUANTITY_EPSILON &&
        plan.leverage === account.position.leverage
      : null;

  if (planMatchesPosition === false)
    blockedReasons.push('LIVE_POSITION_DIFFERS_FROM_LOCKED_PLAN');

  const lifecycleStage =
    paperTrade || liveTrades.active || account.position
      ? ('MANAGING' as const)
      : plan?.status === 'ENTERED'
        ? ('ENTRY_READY' as const)
        : plan?.status === 'LOCKED'
          ? ('WATCHING' as const)
          : lastCompletedPaperTrade || liveTrades.lastCompleted
            ? ('CLOSED' as const)
            : ('FLAT' as const);
  const lifecycleTrade =
    paperTrade ??
    liveTrades.active ??
    lastCompletedPaperTrade ??
    liveTrades.lastCompleted;

  return {
    mode: settings.tradingMode,
    lifecycle: {
      stage: lifecycleStage,
      mode: settings.tradingMode,
      planId:
        plan?.id ??
        paperTrade?.planId ??
        liveTrades.active?.planId ??
        liveTrades.lastCompleted?.planId ??
        null,
      tradeId: lifecycleTrade?.id ?? null,
      positionSource: paperTrade
        ? 'PAPER'
        : liveTrades.active || account.position
          ? 'BINANCE_READ_ONLY'
          : 'NONE',
      startedAt:
        lifecycleTrade?.openedAt ??
        plan?.lockedAt ??
        null,
      updatedAt:
        lifecycleTrade?.updatedAt ??
        plan?.lockedAt ??
        now,
      blockedReasons:
        lifecycleStage === 'MANAGING' && account.position
          ? blockedReasons
          : [],
    },
    activePlan: plan,
    activePaperTrade: paperTrade,
    lastCompletedPaperTrade,
    activeLiveTrade: liveTrades.active,
    lastCompletedLiveTrade: liveTrades.lastCompleted,
    statistics: database.readTradingStatistics(),
    liveManual: {
      available: blockedReasons.length === 0,
      blockedReasons,
      position: account.position,
      protectiveOrders,
      protectiveCoverage,
      recentTrades: account.recentTrades,
      currentTrade: liveTrades.active,
      lastCompletedTrade: liveTrades.lastCompleted,
      realizedPnl:
        liveTrades.active?.realizedNetPnl ??
        liveTrades.lastCompleted?.realizedNetPnl ??
        null,
      planMatchesPosition,
    },
  };
}
