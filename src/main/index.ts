import { app } from 'electron';
import type { BrowserWindow, Tray } from 'electron';
import started from 'electron-squirrel-startup';

import { createAppTray } from './app/tray';
import { createMainWindow } from './app/create-window';
import { OperationalNotificationMonitor } from './app/operational-notifications';
import { AppDatabase } from './db/database';
import { registerIpcHandlers } from './ipc/register-handlers';
import { logger } from './logging/logger';
import { MarketDataService } from './market/service';
import type { SnapshotOptions } from './market/snapshot';
import { RelayUploader } from './relay/uploader';
import { AccountService } from './binance/account/service';
import { CredentialStore } from './security/credential-store';
import { RelayConfigurationStore } from './security/relay-configuration-store';

if (started) {
  app.quit();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let database: AppDatabase | null = null;
let marketData: MarketDataService | null = null;
let relayUploader: RelayUploader | null = null;
let accountService: AccountService | null = null;
let notificationMonitor: OperationalNotificationMonitor | null = null;
let quitting = false;

function showMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow({ shouldQuit: () => quitting });
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function quitApplication(): void {
  quitting = true;
  app.quit();
}

app.on('second-instance', showMainWindow);

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  database?.close();
  database = null;
  marketData?.stop();
  marketData = null;
  relayUploader?.stop();
  relayUploader = null;
  accountService?.stop();
  accountService = null;
  notificationMonitor?.stop();
  notificationMonitor = null;
});

app.on('activate', showMainWindow);

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    return;
  }

  // Windows에서는 트레이 감시 프로세스를 유지한다.
});

void app.whenReady().then(() => {
  app.setAppUserModelId('com.local.btc-futures-assistant');

  database = new AppDatabase(app.getPath('userData'));
  app.setLoginItemSettings({
    openAtLogin: database.readUserSettings().autoStart,
  });
  marketData = new MarketDataService(database);
  const relayStore = new RelayConfigurationStore(database);
  accountService = new AccountService(
    new CredentialStore(database),
    () => marketData?.getServerOffsetMs() ?? 0,
  );
  mainWindow = createMainWindow({ shouldQuit: () => quitting });
  tray = createAppTray({
    showWindow: showMainWindow,
    quitApplication,
  });
  const getSnapshotOptions = (): SnapshotOptions => {
    const accountStatus = accountService!.getStatus();
    const settings = database!.readUserSettings();
    return {
      serverTime: Date.now() + marketData!.getServerOffsetMs(),
      position: accountStatus.connected
        ? accountStatus.position
        : database!.readManualPosition(),
      accountStatus,
      makerFeeRate:
        accountStatus.commission?.makerRate ?? settings.makerFeeRate,
      takerFeeRate:
        accountStatus.commission?.takerRate ?? settings.takerFeeRate,
      entrySlippageBps: settings.entrySlippageBps,
      exitSlippageBps: settings.exitSlippageBps,
      maxLossUsdt: settings.maxLossUsdt,
      riskPercent: settings.riskPercent,
    };
  };
  const startRelay = (baseUrl: string, uploadKey: string): RelayUploader => {
    relayUploader?.stop();
    const uploader = new RelayUploader(
      marketData!.cache,
      {
        baseUrl,
        uploadKey,
      },
      getSnapshotOptions,
    );
    relayUploader = uploader;
    uploader.start();
    return uploader;
  };

  registerIpcHandlers({
    database,
    marketData,
    accountService,
    getRelayStatus: () =>
      relayUploader?.getStatus() ?? {
        configured: false,
        baseUrl: null,
        connected: false,
        lastAttemptAt: null,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        error: null,
      },
    configureRelay: async (input) => {
      const candidate = new RelayUploader(marketData!.cache, input);
      await candidate.testConnection();
      relayStore.save(input);
      startRelay(input.baseUrl, input.uploadKey);
    },
    disconnectRelay: () => {
      relayUploader?.stop();
      relayUploader = null;
      relayStore.clear();
    },
    isTrayReady: () => tray !== null && !tray.isDestroyed(),
  });
  void marketData.start().catch((error: unknown) => {
    logger.error({ error }, 'Market data service failed to start');
  });
  const environmentRelay =
    process.env.BTC_RELAY_URL && process.env.BTC_RELAY_UPLOAD_KEY
      ? {
          baseUrl: process.env.BTC_RELAY_URL,
          uploadKey: process.env.BTC_RELAY_UPLOAD_KEY,
        }
      : null;
  const storedRelay = relayStore.load();
  if (environmentRelay) relayStore.save(environmentRelay);
  const relayConfiguration = environmentRelay ?? storedRelay;
  if (relayConfiguration)
    startRelay(relayConfiguration.baseUrl, relayConfiguration.uploadKey);
  accountService.start();
  notificationMonitor = new OperationalNotificationMonitor(
    () => marketData?.cache.health().status ?? 'DISCONNECTED',
    () =>
      relayUploader?.getStatus() ?? {
        configured: false,
        baseUrl: null,
        connected: false,
        lastAttemptAt: null,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        error: null,
      },
  );
  notificationMonitor.start();

  logger.info(
    {
      appVersion: app.getVersion(),
      platform: process.platform,
      databaseReady: database.isReady(),
    },
    'BTC Futures Assistant Phase 0 started',
  );
});
