import { app } from 'electron';
import type { BrowserWindow, Tray } from 'electron';
import started from 'electron-squirrel-startup';

import { createAppTray } from './app/tray';
import { createMainWindow } from './app/create-window';
import { AppDatabase } from './db/database';
import { registerIpcHandlers } from './ipc/register-handlers';
import { logger } from './logging/logger';

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
  mainWindow = createMainWindow({ shouldQuit: () => quitting });
  tray = createAppTray({
    showWindow: showMainWindow,
    quitApplication,
  });

  registerIpcHandlers({
    database,
    isTrayReady: () => tray !== null && !tray.isDestroyed(),
  });

  logger.info(
    {
      appVersion: app.getVersion(),
      platform: process.platform,
      databaseReady: database.isReady(),
    },
    'BTC Futures Assistant Phase 0 started',
  );
});
