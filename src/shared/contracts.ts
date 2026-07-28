export const IPC_CHANNELS = {
  getPhaseZeroStatus: 'phase-zero:get-status',
  testNotification: 'phase-zero:test-notification',
  copyText: 'phase-zero:copy-text',
  openExternal: 'phase-zero:open-external',
  writeDbCheck: 'phase-zero:write-db-check',
  readDbCheck: 'phase-zero:read-db-check',
  getMarketStatus: 'market:get-status',
  getLatestSnapshot: 'market:get-latest-snapshot',
  configureAccount: 'account:configure',
  disconnectAccount: 'account:disconnect',
  getAccountStatus: 'account:get-status',
  saveManualPosition: 'position:save-manual',
  clearManualPosition: 'position:clear-manual',
  getManualPosition: 'position:get-manual',
  getRelayStatus: 'relay:get-status',
  getUserSettings: 'settings:get',
  saveUserSettings: 'settings:save',
  calculatePositionPlan: 'calculations:position-plan',
  configureRelay: 'relay:configure',
  disconnectRelay: 'relay:disconnect',
  resetLocalData: 'settings:reset-local-data',
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
  live: unknown[] | null;
  indicators: {
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
    rsi14: number | null;
    atr14: number | null;
    atrPercent: number | null;
    volumeSma20: number | null;
    volumeRatio: number | null;
    volumeZScore: number | null;
    vwap: number | null;
    high20: number | null;
    low20: number | null;
    high50: number | null;
    low50: number | null;
    pivotHigh: number | null;
    pivotLow: number | null;
    return1: number | null;
    return3: number | null;
    return12: number | null;
    realizedVolatility: number | null;
  };
  liveIndicators: {
    ema20: number | null;
    vwap: number | null;
  } | null;
  status: DataStatus;
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
  strategy: {
    leverage: 10;
    marginMode: 'ISOLATED';
    minimumNetMarginRoiPercent: 2;
    maxLossUsdt: number | null;
    riskPercent: number | null;
  };
  marketState: {
    lastPrice: number | null;
    markPrice: number | null;
    indexPrice: number | null;
    bidPrice: number | null;
    askPrice: number | null;
    spread: number | null;
    spreadBps: number | null;
    fundingRate: number | null;
    nextFundingTime: number | null;
    basis: number | null;
    basisPercent: number | null;
    priceChangePercent24h: number | null;
    highPrice24h: number | null;
    lowPrice24h: number | null;
    volume24h: number | null;
    quoteVolume24h: number | null;
  };
  orderFlow: Record<
    '1m' | '5m' | '15m' | '1h',
    {
      takerBuyVolume: number;
      takerSellVolume: number;
      buyRatio: number | null;
      sellRatio: number | null;
      delta: number;
      cumulativeDelta: number;
      tradeCount: number;
      averageTradeSize: number | null;
    }
  > & {
    orderBookImbalance5: number | null;
    orderBookImbalance10: number | null;
    orderBookImbalance20: number | null;
    bidNotional20: number;
    askNotional20: number;
    estimatedSlippage: Record<
      '0.01btc' | '0.1btc',
      { buyBps: number | null; sellBps: number | null }
    >;
  };
  openInterest: {
    current: number | null;
    notional: number | null;
    changes: Partial<Record<'5m' | '15m' | '1h' | '4h', number | null>>;
  };
  sentiment: {
    globalLongShortAccountRatio: number | null;
    topLongShortAccountRatio: number | null;
    topLongShortPositionRatio: number | null;
    takerBuySellRatio: number | null;
    updatedAt: number | null;
  };
  liquidations: Record<
    '1m' | '5m' | '15m' | '1h',
    {
      longNotional: number;
      shortNotional: number;
      netNotional: number;
      eventCount: number;
    }
  >;
  position:
    | (AccountStatus['position'] & { source: 'BINANCE_READ_ONLY' })
    | ManualPosition
    | { source: 'NONE'; side: 'FLAT'; updatedAt: null };
  account: {
    connected: boolean;
    lastUpdatedAt: number | null;
    availableBalance: number | null;
    commission: AccountStatus['commission'];
    openOrders: AccountStatus['openOrders'];
  };
  costSettings: {
    makerFeeRate: number | null;
    takerFeeRate: number | null;
    entrySlippageBps: number | null;
    exitSlippageBps: number | null;
  };
  productFilters: {
    tickSize: number;
    stepSize: number;
    minQuantity: number;
    minNotional: number;
    updatedAt: number;
  } | null;
  sourceHealth: Record<
    string,
    {
      status: DataStatus;
      eventTime: number | null;
      receivedTime: number | null;
      ageMs: number;
      lastSuccess: number | null;
      consecutiveFailures: number;
      reconnectCount: number;
      validationError: string | null;
    }
  >;
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

export interface AccountConfigurationInput {
  apiKey: string;
  apiSecret: string;
}

export interface AccountStatus {
  configured: boolean;
  connected: boolean;
  lastUpdatedAt: number | null;
  error: string | null;
  position: {
    source: 'BINANCE_READ_ONLY';
    side: 'LONG' | 'SHORT';
    quantity: number;
    entryPrice: number;
    breakEvenPrice: number | null;
    markPrice: number;
    unrealizedPnl: number;
    isolatedMargin: number;
    liquidationPrice: number | null;
    leverage: 10;
    marginMode: 'ISOLATED';
    updatedAt: number;
  } | null;
  commission: {
    makerRate: number;
    takerRate: number;
    updatedAt: number;
  } | null;
  balance: {
    availableBalance: number | null;
    updatedAt: number;
  } | null;
  openOrders: Array<{
    side: 'BUY' | 'SELL';
    type: string;
    price: number;
    stopPrice: number;
    quantity: number;
    reduceOnly: boolean;
    closePosition: boolean;
    protective: boolean;
    updatedAt: number;
  }>;
}

export interface ManualPosition {
  source: 'MANUAL';
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  notional: number;
  isolatedMargin: number;
  leverage: 10;
  marginMode: 'ISOLATED';
  stopPrice: number | null;
  targetPrices: number[];
  entryOrderType: 'MAKER' | 'TAKER';
  plannedExitOrderType: 'MAKER' | 'TAKER';
  openedAt: number | null;
  updatedAt: number;
}

export interface ManualPositionInput {
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  stopPrice?: number | null;
  targetPrices?: number[];
  entryOrderType?: 'MAKER' | 'TAKER';
  plannedExitOrderType?: 'MAKER' | 'TAKER';
  openedAt?: number | null;
}

export interface RelayStatus {
  configured: boolean;
  baseUrl: string | null;
  connected: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  error: string | null;
}

export interface RelayConfigurationInput {
  baseUrl: string;
  uploadKey: string;
}

export interface UserSettings {
  gptUrl: string;
  makerFeeRate: number | null;
  takerFeeRate: number | null;
  entrySlippageBps: number | null;
  exitSlippageBps: number | null;
  maxLossUsdt: number | null;
  riskPercent: number | null;
  partialTakeProfitRatios: [number, number, number];
  minimumNetMarginRoiPercent: 2;
  autoStart: boolean;
}

export interface PositionCalculationInput {
  side: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  target: number;
  maxLossUsdt?: number | null;
  accountEquity?: number | null;
  riskPercent?: number | null;
  entryOrderType?: 'MAKER' | 'TAKER';
  exitOrderType?: 'MAKER' | 'TAKER';
}

export interface PositionCalculationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  quantity: number | null;
  breakevenPrice: number | null;
  estimatedMaxLoss: number | null;
  target: {
    grossPnl: number;
    netPnl: number;
    initialMargin: number;
    netMarginRoiPercent: number;
    entryFee: number;
    exitFee: number;
    slippage: number;
  } | null;
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
  configureAccount(input: AccountConfigurationInput): Promise<ActionResult>;
  disconnectAccount(): Promise<ActionResult>;
  getAccountStatus(): Promise<AccountStatus>;
  saveManualPosition(input: ManualPositionInput): Promise<ManualPosition>;
  clearManualPosition(): Promise<ActionResult>;
  getManualPosition(): Promise<ManualPosition | null>;
  getRelayStatus(): Promise<RelayStatus>;
  getUserSettings(): Promise<UserSettings>;
  saveUserSettings(settings: UserSettings): Promise<UserSettings>;
  calculatePositionPlan(
    input: PositionCalculationInput,
  ): Promise<PositionCalculationResult>;
  configureRelay(input: RelayConfigurationInput): Promise<ActionResult>;
  disconnectRelay(): Promise<ActionResult>;
  resetLocalData(): Promise<ActionResult>;
}
