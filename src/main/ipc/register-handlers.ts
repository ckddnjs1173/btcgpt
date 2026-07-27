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
  type PhaseZeroStatus,
} from '../../shared/contracts';
import {
  allowedExternalUrlSchema,
  clipboardTextSchema,
  databaseCheckInputSchema,
} from '../../shared/schemas';
import type { AppDatabase } from '../db/database';
import { logger } from '../logging/logger';

interface RegisterIpcHandlersOptions {
  database: AppDatabase;
  isTrayReady: () => boolean;
}

function resetHandler(channel: string): void {
  ipcMain.removeHandler(channel);
}

export function registerIpcHandlers({
  database,
  isTrayReady,
}: RegisterIpcHandlersOptions): void {
  Object.values(IPC_CHANNELS).forEach(resetHandler);

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
      body: 'Phase 0 Windows 알림이 정상 작동합니다.',
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

  ipcMain.handle(IPC_CHANNELS.getMarketStatus, (): MarketStatus => ({
    symbol: 'BTCUSDT',
    lastSnapshotAt: null,
    markPrice: null,
    indexPrice: null,
    timeframeCounts: {
      '5m': 0,
      '15m': 0,
      '1h': 0,
      '4h': 0,
    },
    dataStatus: 'INITIALIZING',
  }));

  ipcMain.handle(IPC_CHANNELS.getLatestSnapshot, async (): Promise<MarketSnapshot> => {
    throw new Error('Snapshot generation is not yet available.');
  });

  logger.info('Restricted Phase 0 IPC handlers registered');
}
