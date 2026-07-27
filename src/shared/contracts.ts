export const IPC_CHANNELS = {
  getPhaseZeroStatus: 'phase-zero:get-status',
  testNotification: 'phase-zero:test-notification',
  copyText: 'phase-zero:copy-text',
  openExternal: 'phase-zero:open-external',
  writeDbCheck: 'phase-zero:write-db-check',
  readDbCheck: 'phase-zero:read-db-check',
} as const;

export interface PhaseZeroStatus {
  appVersion: string;
  platform: NodeJS.Platform;
  databaseReady: boolean;
  notificationSupported: boolean;
  trayReady: boolean;
  security: {
    contextIsolation: true;
    nodeIntegration: false;
    sandbox: true;
  };
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface DatabaseCheck {
  ok: boolean;
  value: string | null;
  updatedAt: number | null;
  recordCount: number;
}

export interface WriteDatabaseCheckInput {
  value: string;
}

export interface DesktopApi {
  getPhaseZeroStatus(): Promise<PhaseZeroStatus>;
  testNotification(): Promise<ActionResult>;
  copyText(text: string): Promise<ActionResult>;
  openExternal(url: string): Promise<ActionResult>;
  writeDbCheck(input: WriteDatabaseCheckInput): Promise<DatabaseCheck>;
  readDbCheck(): Promise<DatabaseCheck>;
}
