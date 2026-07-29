import {
  Notification as ElectronNotification,
  app,
  clipboard,
  ipcMain,
  shell,
} from 'electron';

import {
  IPC_CHANNELS,
  type ActionResult,
  type AccountStatus,
  type MarketSnapshot,
  type MarketStatus,
  type ManualPosition,
  type PhaseZeroStatus,
  type RelayStatus,
  type PositionCalculationResult,
  type PositionCalculationInput,
  type LockedTradePlan,
  type TradingState,
  type PaperTrade,
  type RelayConfigurationInput,
  type UserSettings,
} from '../../shared/contracts';
import {
  allowedExternalUrlSchema,
  accountConfigurationSchema,
  clipboardTextSchema,
  databaseCheckInputSchema,
  manualPositionInputSchema,
  positionCalculationInputSchema,
  lockTradePlanInputSchema,
  paperCloseInputSchema,
  relayConfigurationSchema,
  userSettingsSchema,
  naverConfigurationSchema,
} from '../../shared/schemas';
import type { AppDatabase } from '../db/database';
import { logger } from '../logging/logger';
import type { MarketDataService } from '../market/service';
import { generateSnapshot } from '../market/snapshot';
import type { AccountService } from '../binance/account/service';
import type { ExternalContextService } from '../external/service';
import {
  breakevenExitPrice,
  calculatePositionPlan as calculatePlan,
  signedFundingPayment,
  validateExactPositionSize,
  isStepAligned,
} from '../../shared/calculations/costs';
import { randomUUID } from 'node:crypto';

interface RegisterIpcHandlersOptions {
  database: AppDatabase;
  isTrayReady: () => boolean;
  marketData: MarketDataService;
  accountService: AccountService;
  externalContext: ExternalContextService;
  getRelayStatus: () => RelayStatus;
  configureRelay: (input: RelayConfigurationInput) => Promise<void>;
  disconnectRelay: () => void;
  configureNaver: (input: {
    clientId: string;
    clientSecret: string;
  }) => void;
  disconnectNaver: () => void;
}

function resetHandler(channel: string): void {
  ipcMain.removeHandler(channel);
}

export function registerIpcHandlers({
  database,
  isTrayReady,
  marketData,
  accountService,
  externalContext,
  getRelayStatus,
  configureRelay,
  disconnectRelay,
  configureNaver,
  disconnectNaver,
}: RegisterIpcHandlersOptions): void {
  Object.values(IPC_CHANNELS).forEach(resetHandler);
  ipcMain.handle(IPC_CHANNELS.configureNaver, (_event, raw: unknown) => {
    configureNaver(naverConfigurationSchema.parse(raw));
    return { ok: true, message: 'Naver 뉴스 연결 정보를 암호화 저장했습니다.' };
  });
  ipcMain.handle(IPC_CHANNELS.disconnectNaver, () => {
    disconnectNaver();
    return { ok: true, message: 'Naver 뉴스 연결 정보를 삭제했습니다.' };
  });

  ipcMain.handle(IPC_CHANNELS.getPhaseZeroStatus, (): PhaseZeroStatus => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    databaseReady: database.isReady(),
    notificationSupported: ElectronNotification.isSupported(),
    trayReady: isTrayReady(),
    security: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }));

  ipcMain.handle(IPC_CHANNELS.testNotification, (): ActionResult => {
    if (!ElectronNotification.isSupported()) {
      return {
        ok: false,
        message: '현재 운영체제에서 데스크톱 알림을 지원하지 않습니다.',
      };
    }

    new ElectronNotification({
      title: 'BTC Futures Assistant',
      body: 'Windows 운영 알림이 정상 작동합니다.',
      silent: false,
    }).show();

    return { ok: true, message: '테스트 알림을 보냈습니다.' };
  });

  ipcMain.handle(
    IPC_CHANNELS.copyText,
    (_event, rawText: unknown): ActionResult => {
      const text = clipboardTextSchema.parse(rawText);
      clipboard.writeText(text);

      return { ok: true, message: '클립보드에 복사했습니다.' };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.configureAccount,
    async (_event, rawInput: unknown): Promise<ActionResult> => {
      const input = accountConfigurationSchema.parse(rawInput);
      await accountService.configure(input);
      externalContext.reloadAnnouncements();
      return { ok: true, message: '읽기 전용 Binance 계정을 연결했습니다.' };
    },
  );
  ipcMain.handle(IPC_CHANNELS.disconnectAccount, (): ActionResult => {
    accountService.disconnect();
    externalContext.reloadAnnouncements();
    return { ok: true, message: '계정 연결과 저장된 인증정보를 삭제했습니다.' };
  });
  ipcMain.handle(IPC_CHANNELS.getAccountStatus, (): AccountStatus =>
    accountService.getStatus(),
  );
  ipcMain.handle(
    IPC_CHANNELS.saveManualPosition,
    (_event, rawInput: unknown): ManualPosition =>
      database.saveManualPosition(manualPositionInputSchema.parse(rawInput)),
  );
  ipcMain.handle(IPC_CHANNELS.clearManualPosition, (): ActionResult => {
    database.clearManualPosition();
    return { ok: true, message: '수동 포지션을 삭제했습니다.' };
  });
  ipcMain.handle(IPC_CHANNELS.getManualPosition, (): ManualPosition | null =>
    database.readManualPosition(),
  );
  ipcMain.handle(IPC_CHANNELS.getRelayStatus, (): RelayStatus =>
    getRelayStatus(),
  );
  ipcMain.handle(
    IPC_CHANNELS.configureRelay,
    async (_event, rawInput: unknown): Promise<ActionResult> => {
      await configureRelay(relayConfigurationSchema.parse(rawInput));
      return {
        ok: true,
        message: '중계소 설정을 암호화 저장하고 업로드를 시작했습니다.',
      };
    },
  );
  ipcMain.handle(IPC_CHANNELS.disconnectRelay, (): ActionResult => {
    disconnectRelay();
    return {
      ok: true,
      message: '중계소 연결과 저장된 업로드 키를 삭제했습니다.',
    };
  });
  ipcMain.handle(IPC_CHANNELS.getUserSettings, (): UserSettings =>
    database.readUserSettings(),
  );
  ipcMain.handle(
    IPC_CHANNELS.saveUserSettings,
    (_event, rawInput: unknown): UserSettings => {
      const saved = database.saveUserSettings(
        userSettingsSchema.parse(rawInput),
      );
      app.setLoginItemSettings({ openAtLogin: saved.autoStart });
      return saved;
    },
  );
  ipcMain.handle(IPC_CHANNELS.resetLocalData, (): ActionResult => {
    accountService.disconnect();
    disconnectRelay();
    database.clearLocalData();
    app.setLoginItemSettings({ openAtLogin: false });
    return {
      ok: true,
      message:
        '로컬 캔들·설정·수동 포지션·저장된 인증정보를 초기화했습니다. 앱을 다시 시작하면 메모리 데이터도 초기화됩니다.',
    };
  });
  const validatePositionPlan = (
    rawInput: unknown,
  ): PositionCalculationResult => {
      const input = positionCalculationInputSchema.parse(rawInput);
      const settings = database.readUserSettings();
      const accountCommission = accountService.getStatus().commission;
      const makerFeeRate =
        accountCommission?.makerRate ?? settings.makerFeeRate;
      const takerFeeRate =
        accountCommission?.takerRate ?? settings.takerFeeRate;
      const filters = marketData.cache.productFilters;
      const errors: string[] = [];
      if (makerFeeRate === null || takerFeeRate === null)
        errors.push('FEE_RATE_REQUIRED');
      if (
        settings.entrySlippageBps === null ||
        settings.exitSlippageBps === null
      )
        errors.push('SLIPPAGE_INPUT_REQUIRED');
      if (!filters) errors.push('PRODUCT_FILTERS_REQUIRED');
      const account = accountService.getStatus();
      if (!account.connected) errors.push('BINANCE_READ_ONLY_ACCOUNT_REQUIRED');
      if (account.leverageBrackets.length === 0)
        errors.push('LEVERAGE_BRACKETS_REQUIRED');
      if (
        (input.side === 'LONG' &&
          (input.stop >= input.entry || input.target <= input.entry)) ||
        (input.side === 'SHORT' &&
          (input.stop <= input.entry || input.target >= input.entry))
      )
        errors.push('INVALID_STOP_OR_TARGET_DIRECTION');
      if (errors.length || !filters)
        return {
          valid: false,
          errors,
          warnings: [],
          quantity: null,
          requestedQuantity: null,
          notional: null,
          isolatedMargin: null,
          leverage: input.leverage,
          sizeMode: input.sizeMode,
          sizeValue: input.sizeValue ?? null,
          breakevenPrice: null,
          estimatedLiquidationPrice: null,
          liquidationDistancePercent: null,
          maximumAllowed: {
            leverage: null,
            notional: null,
            quantity: null,
            margin: null,
          },
          estimatedMaxLoss: null,
          target: null,
        };
      const entryFeeRate =
        (input.entryOrderType ?? 'TAKER') === 'MAKER'
          ? (makerFeeRate ?? 0)
          : (takerFeeRate ?? 0);
      const exitFeeRate =
        (input.exitOrderType ?? 'TAKER') === 'MAKER'
          ? (makerFeeRate ?? 0)
          : (takerFeeRate ?? 0);
      const slippageRate =
        Math.max(
          settings.entrySlippageBps ?? 0,
          settings.exitSlippageBps ?? 0,
        ) / 10_000;
      const entrySlippageRate = (settings.entrySlippageBps ?? 0) / 10_000;
      const exitSlippageRate = (settings.exitSlippageBps ?? 0) / 10_000;
      const provisionalQuantity =
        input.sizeMode === 'MARGIN_USDT' && input.sizeValue
          ? (input.sizeValue * input.leverage) / input.entry
          : input.sizeMode === 'QUANTITY_BTC' && input.sizeValue
            ? input.sizeValue
            : input.sizeMode === 'NOTIONAL_USDT' && input.sizeValue
              ? input.sizeValue / input.entry
              : input.sizeValue && input.sizeMode === 'MAX_LOSS_USDT'
                ? input.sizeValue /
                  (Math.abs(input.entry - input.stop) +
                    input.entry * (entryFeeRate + slippageRate) +
                    input.stop * (exitFeeRate + slippageRate))
                : 0;
      const provisionalNotional = provisionalQuantity * input.entry;
      const bracket =
        account.leverageBrackets.find(
          (candidate) =>
            provisionalNotional >= candidate.notionalFloor &&
            provisionalNotional <= candidate.notionalCap,
        ) ?? account.leverageBrackets.at(-1);
      if (!input.sizeValue || !bracket)
        return {
          valid: false,
          errors: [
            !input.sizeValue ? 'SIZE_VALUE_REQUIRED' : 'LEVERAGE_BRACKET_NOT_FOUND',
          ],
          warnings: [],
          quantity: null,
          requestedQuantity: null,
          notional: null,
          isolatedMargin: null,
          leverage: input.leverage,
          sizeMode: input.sizeMode,
          sizeValue: input.sizeValue ?? null,
          breakevenPrice: null,
          estimatedLiquidationPrice: null,
          liquidationDistancePercent: null,
          maximumAllowed: {
            leverage: bracket?.initialLeverage ?? null,
            notional: bracket?.notionalCap ?? null,
            quantity: bracket ? bracket.notionalCap / input.entry : null,
            margin: bracket ? bracket.notionalCap / input.leverage : null,
          },
          estimatedMaxLoss: null,
          target: null,
        };
      const quantity = validateExactPositionSize({
        side: input.side,
        entry: input.entry,
        stop: input.stop,
        leverage: input.leverage,
        sizeMode: input.sizeMode,
        sizeValue: input.sizeValue,
        maximumLeverage: bracket.initialLeverage,
        maximumNotional: bracket.notionalCap,
        maintenanceMarginRate: bracket.maintenanceMarginRate,
        maxLossUsdt:
          input.maxLossUsdt ??
          (input.sizeMode === 'MAX_LOSS_USDT'
            ? input.sizeValue
            : settings.maxLossUsdt),
        accountEquity: input.accountEquity,
        riskPercent: input.riskPercent ?? settings.riskPercent,
        availableMargin: account.balance?.availableBalance,
        entryFeeRate,
        exitFeeRate,
        slippageRate,
        stepSize: filters.stepSize,
        minQuantity: filters.minQuantity,
        minNotional: filters.minNotional,
        tickSize: filters.tickSize,
      });
      if (!quantity.valid)
        return {
          valid: false,
          errors: quantity.reasons,
          warnings: quantity.warnings,
          quantity: null,
          requestedQuantity: quantity.requestedQuantity,
          notional: quantity.notional,
          isolatedMargin: quantity.isolatedMargin,
          leverage: input.leverage,
          sizeMode: input.sizeMode,
          sizeValue: input.sizeValue,
          breakevenPrice: null,
          estimatedLiquidationPrice: quantity.estimatedLiquidationPrice,
          liquidationDistancePercent: quantity.liquidationDistancePercent,
          maximumAllowed: {
            leverage: bracket.initialLeverage,
            notional: bracket.notionalCap,
            quantity: quantity.maximumQuantity,
            margin: quantity.maximumMargin,
          },
          estimatedMaxLoss: quantity.estimatedMaxLoss,
          target: null,
        };
      const fundingPayment = signedFundingPayment(
        input.side,
        input.entry * quantity.quantity,
        marketData.cache.state.fundingRate ?? 0,
      );
      const plan = calculatePlan({
        side: input.side,
        entry: input.entry,
        exit: input.target,
        quantity: quantity.quantity,
        entryFeeRate,
        exitFeeRate,
        entrySlippageRate,
        exitSlippageRate,
        fundingRate: fundingPayment / (input.entry * quantity.quantity),
        leverage: input.leverage,
      });
      return {
        valid: true,
        errors: [],
        warnings: quantity.warnings,
        quantity: quantity.quantity,
        requestedQuantity: quantity.requestedQuantity,
        notional: quantity.notional,
        isolatedMargin: quantity.isolatedMargin,
        leverage: input.leverage,
        sizeMode: input.sizeMode,
        sizeValue: input.sizeValue,
        breakevenPrice: breakevenExitPrice(
          input.side,
          input.entry,
          entryFeeRate,
          exitFeeRate,
          entrySlippageRate,
          marketData.cache.state.fundingRate ?? 0,
          exitSlippageRate,
        ),
        estimatedLiquidationPrice: quantity.estimatedLiquidationPrice,
        liquidationDistancePercent: quantity.liquidationDistancePercent,
        maximumAllowed: {
          leverage: bracket.initialLeverage,
          notional: bracket.notionalCap,
          quantity: quantity.maximumQuantity,
          margin: quantity.maximumMargin,
        },
        estimatedMaxLoss: quantity.estimatedMaxLoss,
        target: {
          grossPnl: plan.grossPnl,
          netPnl: plan.netPnl,
          initialMargin: plan.initialMargin,
          netMarginRoiPercent: (plan.netPnl / plan.initialMargin) * 100,
          entryFee: plan.entryFee,
          exitFee: plan.exitFee,
          slippage: plan.slippage,
        },
      };
  };
  ipcMain.handle(
    IPC_CHANNELS.calculatePositionPlan,
    (_event, rawInput: unknown): PositionCalculationResult =>
      validatePositionPlan(rawInput),
  );

  ipcMain.handle(
    IPC_CHANNELS.lockTradePlan,
    (_event, rawInput: unknown): LockedTradePlan => {
      const input = lockTradePlanInputSchema.parse(rawInput);
      const snapshot = generateSnapshot(marketData.cache, {
        serverTime: Date.now() + marketData.getServerOffsetMs(),
      });
      if (!snapshot.analysisGate.analysisAllowed)
        throw new Error('STALE_OR_INCOMPLETE_MARKET_DATA');
      const result = validatePositionPlan(input);
      if (
        !result.valid ||
        result.quantity === null ||
        result.notional === null ||
        result.isolatedMargin === null ||
        result.estimatedMaxLoss === null ||
        result.breakevenPrice === null
      )
        throw new Error(`PLAN_VALIDATION_FAILED:${result.errors.join(',')}`);
      const settings = database.readUserSettings();
      const account = accountService.getStatus();
      const entryFeeRate =
        (input.entryOrderType ?? 'TAKER') === 'MAKER'
          ? (account.commission?.makerRate ?? settings.makerFeeRate ?? 0)
          : (account.commission?.takerRate ?? settings.takerFeeRate ?? 0);
      const exitFeeRate =
        (input.exitOrderType ?? 'TAKER') === 'MAKER'
          ? (account.commission?.makerRate ?? settings.makerFeeRate ?? 0)
          : (account.commission?.takerRate ?? settings.takerFeeRate ?? 0);
      const plan: LockedTradePlan = {
        id: randomUUID(),
        mode: settings.tradingMode,
        status: 'LOCKED',
        side: input.side,
        entry: input.entry,
        stop: input.stop,
        targets: input.targets ?? [input.target],
        leverage: input.leverage,
        marginMode: 'ISOLATED',
        sizeMode: input.sizeMode,
        sizeValue: input.sizeValue!,
        quantity: result.quantity,
        notional: result.notional,
        isolatedMargin: result.isolatedMargin,
        maxLossUsdt: input.maxLossUsdt ?? settings.maxLossUsdt,
        estimatedMaxLoss: result.estimatedMaxLoss,
        breakevenPrice: result.breakevenPrice,
        estimatedLiquidationPrice: result.estimatedLiquidationPrice,
        entryFeeRate,
        exitFeeRate,
        entrySlippageBps: settings.entrySlippageBps ?? 0,
        exitSlippageBps: settings.exitSlippageBps ?? 0,
        fundingRate: marketData.cache.state.fundingRate ?? 0,
        expectedFundingPeriods: input.expectedFundingPeriods,
        snapshotId: snapshot.snapshotId,
        marketGeneratedAt: snapshot.generatedAt,
        lockedAt: Date.now(),
      };
      return database.saveLockedTradePlan(plan);
    },
  );

  ipcMain.handle(IPC_CHANNELS.enterPaperTrade, (): PaperTrade => {
    const plan = database.readActiveLockedTradePlan('PAPER');
    if (!plan || plan.status !== 'LOCKED') throw new Error('PAPER_PLAN_REQUIRED');
    if (database.readActivePaperTrade()) throw new Error('PAPER_TRADE_ALREADY_OPEN');
    const now = Date.now();
    const entryFee = plan.notional * plan.entryFeeRate;
    const entrySlippage =
      plan.notional * (plan.entrySlippageBps / 10_000);
    const trade: PaperTrade = {
      id: randomUUID(),
      planId: plan.id,
      status: 'OPEN',
      side: plan.side,
      entryPrice: plan.entry,
      initialQuantity: plan.quantity,
      remainingQuantity: plan.quantity,
      leverage: plan.leverage,
      isolatedMargin: plan.isolatedMargin,
      openedAt: now,
      closedAt: null,
      realizedGrossPnl: 0,
      feesPaid: entryFee,
      slippagePaid: entrySlippage,
      fundingPaid: 0,
      realizedNetPnl: -entryFee - entrySlippage,
      lastMarkPrice: marketData.cache.state.markPrice ?? plan.entry,
      updatedAt: now,
    };
    database.addPaperTradeEvent({
      tradeId: trade.id,
      eventType: 'ENTRY',
      quantity: trade.initialQuantity,
      price: plan.entry,
      grossPnl: 0,
      fee: entryFee,
      slippage: entrySlippage,
      funding: 0,
      netPnl: -entryFee - entrySlippage,
      occurredAt: now,
    });
    database.updateLockedTradePlanStatus(plan.id, 'ENTERED');
    return database.savePaperTrade(trade);
  });

  const closePaper = (
    rawInput: unknown,
    forceAll: boolean,
  ): PaperTrade => {
    const input = paperCloseInputSchema.parse(rawInput ?? {});
    const trade = database.readActivePaperTrade();
    if (!trade) throw new Error('OPEN_PAPER_TRADE_REQUIRED');
    const plan = database.readActiveLockedTradePlan('PAPER');
    if (!plan || plan.id !== trade.planId) throw new Error('PAPER_PLAN_NOT_FOUND');
    const quantity = forceAll
      ? trade.remainingQuantity
      : (input.quantity ?? 0);
    if (quantity <= 0 || quantity > trade.remainingQuantity)
      throw new Error('INVALID_CLOSE_QUANTITY');
    const filters = marketData.cache.productFilters;
    if (!filters || !isStepAligned(quantity, filters.stepSize))
      throw new Error('CLOSE_QUANTITY_NOT_ALIGNED');
    const exitPrice =
      input.exitPrice ?? marketData.cache.state.markPrice;
    if (!exitPrice) throw new Error('EXIT_PRICE_REQUIRED');
    const gross =
      trade.side === 'LONG'
        ? quantity * (exitPrice - trade.entryPrice)
        : quantity * (trade.entryPrice - exitPrice);
    const exitNotional = quantity * exitPrice;
    const fee = exitNotional * plan.exitFeeRate;
    const slippage = exitNotional * (plan.exitSlippageBps / 10_000);
    const funding =
      plan.notional *
      plan.fundingRate *
      plan.expectedFundingPeriods *
      (quantity / plan.quantity) *
      (plan.side === 'LONG' ? 1 : -1);
    const net = gross - fee - slippage - funding;
    const remainingQuantity = trade.remainingQuantity - quantity;
    const now = Date.now();
    const closed = remainingQuantity <= 1e-12;
    const updated: PaperTrade = {
      ...trade,
      status: closed ? 'CLOSED' : 'PARTIALLY_CLOSED',
      remainingQuantity: closed ? 0 : remainingQuantity,
      closedAt: closed ? now : null,
      realizedGrossPnl: trade.realizedGrossPnl + gross,
      feesPaid: trade.feesPaid + fee,
      slippagePaid: trade.slippagePaid + slippage,
      fundingPaid: trade.fundingPaid + funding,
      realizedNetPnl: trade.realizedNetPnl + net,
      lastMarkPrice: exitPrice,
      updatedAt: now,
    };
    database.addPaperTradeEvent({
      tradeId: trade.id,
      eventType: closed ? 'CLOSE' : 'PARTIAL_CLOSE',
      quantity,
      price: exitPrice,
      grossPnl: gross,
      fee,
      slippage,
      funding,
      netPnl: net,
      occurredAt: now,
    });
    database.updateLockedTradePlanStatus(
      plan.id,
      closed ? 'CLOSED' : 'PARTIALLY_CLOSED',
    );
    return database.savePaperTrade(updated);
  };
  ipcMain.handle(
    IPC_CHANNELS.partiallyClosePaperTrade,
    (_event, rawInput: unknown): PaperTrade => closePaper(rawInput, false),
  );
  ipcMain.handle(
    IPC_CHANNELS.closePaperTrade,
    (_event, rawInput: unknown): PaperTrade => closePaper(rawInput, true),
  );

  const getTradingState = (): TradingState => {
    const settings = database.readUserSettings();
    const account = accountService.getStatus();
    const plan = database.readActiveLockedTradePlan(settings.tradingMode);
    const blockedReasons: string[] = [];
    if (!account.connected) blockedReasons.push('ACCOUNT_NOT_CONNECTED');
    if (!account.position) blockedReasons.push('NO_LIVE_POSITION');
    if (
      account.lastUpdatedAt === null ||
      Date.now() - account.lastUpdatedAt > 60_000
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
    return {
      mode: settings.tradingMode,
      activePlan: plan,
      activePaperTrade: database.readActivePaperTrade(),
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
  };
  ipcMain.handle(
    IPC_CHANNELS.getTradingState,
    (): TradingState => getTradingState(),
  );

  ipcMain.handle(
    IPC_CHANNELS.openExternal,
    async (_event, rawUrl: unknown): Promise<ActionResult> => {
      const url = allowedExternalUrlSchema.parse(rawUrl);
      await shell.openExternal(url);

      return { ok: true, message: '기본 브라우저에서 ChatGPT를 열었습니다.' };
    },
  );

  ipcMain.handle(IPC_CHANNELS.writeDbCheck, (_event, rawInput: unknown) => {
    const input = databaseCheckInputSchema.parse(rawInput);
    return database.writePhaseZeroCheck(input.value);
  });

  ipcMain.handle(IPC_CHANNELS.readDbCheck, () => database.readPhaseZeroCheck());

  ipcMain.handle(IPC_CHANNELS.getMarketStatus, (): MarketStatus =>
    marketData.cache.status(),
  );

  ipcMain.handle(IPC_CHANNELS.getLatestSnapshot, (): MarketSnapshot => {
    const accountStatus = accountService.getStatus();
    const settings = database.readUserSettings();
    return generateSnapshot(marketData.cache, {
      serverTime: Date.now() + marketData.getServerOffsetMs(),
      position: accountStatus.connected
        ? accountStatus.position
        : database.readManualPosition(),
      accountStatus,
      makerFeeRate:
        accountStatus.commission?.makerRate ?? settings.makerFeeRate,
      takerFeeRate:
        accountStatus.commission?.takerRate ?? settings.takerFeeRate,
      entrySlippageBps: settings.entrySlippageBps,
      exitSlippageBps: settings.exitSlippageBps,
      maxLossUsdt: settings.maxLossUsdt,
      riskPercent: settings.riskPercent,
      riskContext: externalContext.getStatus().riskContext,
      defaultLeverage: settings.defaultLeverage,
      tradingState: getTradingState(),
    });
  });

  logger.info('Restricted IPC handlers registered');
}
