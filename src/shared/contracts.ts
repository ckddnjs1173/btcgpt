export const IPC_CHANNELS = {
  getPhaseZeroStatus: 'phase-zero:get-status',
  testNotification: 'phase-zero:test-notification',
  copyText: 'phase-zero:copy-text',
  openExternal: 'phase-zero:open-external',
  writeDbCheck: 'phase-zero:write-db-check',
  readDbCheck: 'phase-zero:read-db-check',
  getMarketStatus: 'market:get-status',
  getLatestSnapshot: 'market:get-latest-snapshot',
} as const;

export type DataStatus =
  | 'INITIALIZING'
  | 'NORMAL'
  | 'DELAYED'
  | 'STALE'
  | 'DISCONNECTED'
  | 'INSUFFICIENT_DATA';

export interface AnalysisGate {
  analysisAllowed: boolean;
  overallStatus: DataStatus;
  generatedAt: number;
  publishedAt: number | null;
  ageMs: number;
  reasons: string[];
  missingFields: string[];
}

export interface TimeframeSnapshot {
  fields: string[];
  closed: Array<unknown[]>;
  live: Array<unknown[]>;
}

export interface MarketSnapshot {
  schemaVersion: number;
  snapshotId: string;
  symbol: 'BTCUSDT';
  market: 'BINANCE_USDM_PERPETUAL';
  generatedAt: number;
  generatedAtKst: string;
  binanceServerTime: number;
  analysisGate: AnalysisGate;
  marketState: {
    markPrice: string;
    indexPrice: string;
    nextFundingTime: number | null;
  };
  timeframes: {
    '5m': TimeframeSnapshot;
    '15m': TimeframeSnapshot;
    '1h': TimeframeSnapshot;
    '4h': TimeframeSnapshot;
  };
}

export interface MarketStatus {
  symbol: 'BTCUSDT';
  lastSnapshotAt: number | null;
  markPrice: string | null;
  indexPrice: string | null;
  timeframeCounts: Record<'5m' | '15m' | '1h' | '4h', number>;
  dataStatus: DataStatus;
}

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
  getMarketStatus(): Promise<MarketStatus>;
  getLatestSnapshot(): Promise<MarketSnapshot>;
}
