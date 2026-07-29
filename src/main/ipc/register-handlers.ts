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
  validateRiskQuantity,
} from '../../shared/calculations/costs';

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
  ipcMain.handle(
    IPC_CHANNELS.calculatePositionPlan,
    (_event, rawInput: unknown): PositionCalculationResult => {
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
          breakevenPrice: null,
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
      const quantity = validateRiskQuantity({
        entry: input.entry,
        stop: input.stop,
        maxLossUsdt: input.maxLossUsdt ?? settings.maxLossUsdt,
        accountEquity: input.accountEquity,
        riskPercent: input.riskPercent ?? settings.riskPercent,
        availableMargin: accountService.getStatus().balance?.availableBalance,
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
          breakevenPrice: null,
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
      });
      return {
        valid: true,
        errors: [],
        warnings: quantity.warnings,
        quantity: quantity.quantity,
        breakevenPrice: breakevenExitPrice(
          input.side,
          input.entry,
          entryFeeRate,
          exitFeeRate,
          entrySlippageRate,
          marketData.cache.state.fundingRate ?? 0,
          exitSlippageRate,
        ),
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
    },
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
    });
  });

  logger.info('Restricted IPC handlers registered');
}
