import type {
  ApprovedPlanMonitoring,
  StructuredTriggerInput,
} from './trading/structured-trigger';
import type { DeribitOptionsIntelligenceV2 } from './options-intelligence';
import type { OnchainIntelligenceV1 } from './onchain-intelligence';
export type {
  ApprovedPlanMonitoring,
  ApprovedPlanMonitoringState,
  ApprovedPlanPriceCondition,
  StructuredTriggerInput,
  StructuredTriggerType,
} from './trading/structured-trigger';

export const IPC_CHANNELS = {
  getPhaseZeroStatus: 'phase-zero:get-status',
  testNotification: 'phase-zero:test-notification',
  copyText: 'phase-zero:copy-text',
  openExternal: 'phase-zero:open-external',
  writeDbCheck: 'phase-zero:write-db-check',
  readDbCheck: 'phase-zero:read-db-check',
  getMarketStatus: 'market:get-status',
  getLatestSnapshot: 'market:get-latest-snapshot',
  getLatestCompactSnapshot: 'market:get-latest-compact-snapshot',
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
  lockTradePlan: 'trading:lock-plan',
  getTradingState: 'trading:get-state',
  enterPaperTrade: 'trading:paper-enter',
  partiallyClosePaperTrade: 'trading:paper-partial-close',
  closePaperTrade: 'trading:paper-close',
  configureRelay: 'relay:configure',
  disconnectRelay: 'relay:disconnect',
  resetLocalData: 'settings:reset-local-data',
  configureNaver: 'external-context:configure-naver',
  disconnectNaver: 'external-context:disconnect-naver',
} as const;

export type DataStatus =
  | 'INITIALIZING'
  | 'NORMAL'
  | 'DELAYED'
  | 'STALE'
  | 'DISCONNECTED'
  | 'INSUFFICIENT_DATA';

export type DataQuality = 'GREEN' | 'YELLOW' | 'RED';

/**
 * Task-specific data gates. A delayed optional source must not block every
 * decision path: market explanation, new entry and open-position management
 * have different minimum data requirements.
 */
export interface DecisionGates {
  marketAnalysisAvailable: boolean;
  entryAllowed: boolean;
  positionManagementAvailable: boolean;
  quality: DataQuality;
  generatedAt: number;
  publishedAt: number | null;
  ageMs: number;
  marketDataAgeMs: number;
  relayPublishAgeMs: number | null;
  criticalBlockers: string[];
  degradedSources: string[];
  missingFields: string[];
}

/**
 * schemaVersion 4 compatibility gate. schemaVersion 5 consumers must prefer
 * decisionGates.
 */
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
  appVersion: string;
  snapshotId: string;
  symbol: 'BTCUSDT';
  market: 'BINANCE_USDM_PERPETUAL';
  generatedAt: number;
  generatedAtKst: string;
  binanceServerTime: number;
  decisionGates: DecisionGates;
  analysisGate: AnalysisGate;
  strategy: {
    leverage: number;
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
    '15s' | '30s' | '1m' | '3m' | '5m' | '15m' | '1h',
    {
      windowStart: number;
      windowEnd: number;
      sampleCount: number;
      takerBuyVolume: number;
      takerSellVolume: number;
      buyRatio: number | null;
      sellRatio: number | null;
      delta: number;
      cumulativeDelta: number;
      tradeCount: number;
      buyTradeCount: number;
      sellTradeCount: number;
      averageTradeSize: number | null;
      tradesPerSecond: number;
      notionalPerSecond: number;
      deltaChangeFromPreviousWindow: number | null;
      priceChangeBps: number | null;
      impactBpsPerBtc: number | null;
      deltaPriceRelation:
        | 'ALIGNED'
        | 'PRICE_UP_DELTA_DOWN'
        | 'PRICE_DOWN_DELTA_UP'
        | 'FLAT_OR_INSUFFICIENT';
    }
  > & {
    orderBookImbalance5: number | null;
    orderBookImbalance10: number | null;
    orderBookImbalance20: number | null;
    orderBookImbalance50: number | null;
    orderBookImbalance100: number | null;
    bidNotional20: number;
    askNotional20: number;
    bidNotional50: number;
    askNotional50: number;
    bidNotional100: number;
    askNotional100: number;
    orderBookSynchronized: boolean;
    orderBookSyncState:
      | 'FETCHING_SNAPSHOT'
      | 'WAITING_FOR_BRIDGE'
      | 'SYNCHRONIZED'
      | 'RETRY_SCHEDULED';
    orderBookLastUpdateId: number | null;
    orderBookLevelCount: number;
    microPrice: number | null;
    sessionCvd: number;
    sessionCvdStartedAt: number | null;
    rollingCvd4h: number;
    estimatedSlippage: Record<
      '0.01btc' | '0.1btc',
      { buyBps: number | null; sellBps: number | null }
    >;
  };
  openInterest: {
    current: number | null;
    notional: number | null;
    changes: Partial<Record<'5m' | '15m' | '1h' | '4h', number | null>>;
    localChanges: {
      '1m': number | null;
      '5m': number | null;
      sampleCount1m: number;
      sampleCount5m: number;
      observedAt: number | null;
    };
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
    stream: AccountStatus['stream'];
    commission: AccountStatus['commission'];
    openOrders: AccountStatus['openOrders'];
    recentTrades: AccountStatus['recentTrades'];
    leverageBrackets: AccountStatus['leverageBrackets'];
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
  connections: {
    publicWebSocket: WebSocketConnectionHealth;
    marketWebSocket: WebSocketConnectionHealth;
  };
  timeframes: {
    '1m': TimeframeSnapshot;
    '3m': TimeframeSnapshot;
    '5m': TimeframeSnapshot;
    '15m': TimeframeSnapshot;
    '30m': TimeframeSnapshot;
    '1h': TimeframeSnapshot;
    '4h': TimeframeSnapshot;
    '1d': TimeframeSnapshot;
    '1w': TimeframeSnapshot;
  };
  riskContext: RiskContext;
  scalpContext: {
    generatedAt: number;
    candles: Record<
      '1m' | '5m',
      {
        closedAt: number | null;
        liveObservedAt: number | null;
        progressRatio: number | null;
        bodyRatio: number | null;
        upperWickRatio: number | null;
        lowerWickRatio: number | null;
        closeLocation: number | null;
        ema20SlopePerCandle: number | null;
        vwapDistanceBps: number | null;
        pivotHighDistanceAtr: number | null;
        pivotLowDistanceAtr: number | null;
        rangeCompression5vs20: number | null;
        liveVolumeRatio: number | null;
        volumeZScore: number | null;
        abovePivotHigh: boolean | null;
        belowPivotLow: boolean | null;
      }
    >;
    depth: {
      observedAt: number | null;
      sampleCount5s: number;
      sampleCount30s: number;
      imbalanceChange5s: number | null;
      imbalanceChange30s: number | null;
      bidDominanceRatio5s: number | null;
      bidWallPrice: number | null;
      bidWallNotional: number | null;
      askWallPrice: number | null;
      askWallNotional: number | null;
      bidWallPersistence5s: number | null;
      askWallPersistence5s: number | null;
      bidWallNotionalChange5s: number | null;
      askWallNotionalChange5s: number | null;
      bidWallPriceMoveBps5s: number | null;
      askWallPriceMoveBps5s: number | null;
      bidWallAbsorbedSellVolume5s: number | null;
      askWallAbsorbedBuyVolume5s: number | null;
    };
  };
  trading: TradingState;
}

export type ContextStatus =
  | 'INITIALIZING'
  | 'NORMAL'
  | 'DELAYED'
  | 'STALE'
  | 'DISCONNECTED'
  | 'INSUFFICIENT_DATA'
  | 'DISABLED'
  | 'UNAVAILABLE';

export type ExternalContextHorizon = 'INTRADAY' | 'SWING' | 'MACRO';
export type ExternalContextCategory =
  | 'BINANCE'
  | 'MACRO'
  | 'REGULATION'
  | 'NEWS'
  | 'OPTIONS'
  | 'ONCHAIN'
  | 'SENTIMENT';
export type TrustTier =
  'OFFICIAL' | 'MULTI_SOURCE' | 'SINGLE_SOURCE' | 'UNVERIFIED_SOCIAL';

export interface ExternalContextItem {
  id: string;
  source: string;
  category: ExternalContextCategory;
  title: string;
  snippet: string | null;
  url: string;
  publishedAt: number;
  observedAt: number;
  language: string | null;
  trustTier: TrustTier;
  btcRelevance: 'HIGH' | 'MEDIUM' | 'LOW';
  duplicateGroupId: string | null;
  duplicateCount: number;
  tags: string[];
}

export interface ExternalSourceHealth {
  status: ContextStatus;
  lastSuccess: number | null;
  lastFailure: number | null;
  nextAttemptAt: number | null;
  ageMs: number | null;
  consecutiveFailures: number;
  error: string | null;
}

export interface WebSocketConnectionHealth {
  status: 'CONNECTED' | 'DISCONNECTED';
  connected: boolean;
  lastConnectedAt: number | null;
  lastEventAt: number | null;
  reconnectCount: number;
  consecutiveFailures: number;
  errorCode: string | null;
}

export interface RiskContext {
  status: ContextStatus;
  updatedAt: number | null;
  highRiskNews: boolean;
  representativeEventId: string | null;
  nextMacroEvent: { name: string; at: number; remainingMs: number } | null;
  binanceCriticalNotice: boolean;
  optionsVolatilityState: string | null;
  onchainAnomaly: boolean;
  fearAndGreed: { value: number; classification: string; at: number } | null;
  sourceWarnings: string[];
}

export interface ExternalContextSnapshot {
  schemaVersion: 2;
  generatedAt: number;
  status: ContextStatus;
  horizon: ExternalContextHorizon;
  items: ExternalContextItem[];
  sourceHealth: Record<string, ExternalSourceHealth>;
  riskContext: RiskContext;
  optionsV2: DeribitOptionsIntelligenceV2 | null;
  onchainV1: OnchainIntelligenceV1 | null;
}

export interface ExternalContextStatus {
  status: ContextStatus;
  updatedAt: number | null;
  riskContext: RiskContext;
  sourceHealth: Record<string, ExternalSourceHealth>;
}

export interface MarketStatus {
  symbol: 'BTCUSDT';
  lastSnapshotAt: number | null;
  markPrice: string | null;
  indexPrice: string | null;
  timeframeCounts: Record<
    '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h',
    number
  >;
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
  stream: {
    status: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';
    lastEventAt: number | null;
    lastAccountUpdateAt: number | null;
    lastOrderTradeUpdateAt: number | null;
    reconnectCount: number;
    error: string | null;
  };
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
    leverage: number;
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
  recentTrades: Array<{
    tradeId: string;
    orderId: string;
    side: 'BUY' | 'SELL';
    positionSide: 'BOTH' | 'LONG' | 'SHORT';
    price: number;
    quantity: number;
    realizedPnl: number;
    commission: number;
    commissionAsset: string;
    maker: boolean;
    timestamp: number;
  }>;
  leverageBrackets: Array<{
    bracket: number;
    initialLeverage: number;
    notionalFloor: number;
    notionalCap: number;
    maintenanceMarginRate: number;
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
  leverage: number;
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
  leverage?: number;
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
  lastPayloadBytes?: number | null;
  lastSnapshotGeneratedAt?: number | null;
  lastServerReceivedAt?: number | null;
  lastRoundTripMs?: number | null;
  lastMarketToRelayReceiveMs?: number | null;
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
  tradingMode: TradingMode;
  defaultLeverage: number;
}

export type TradingMode = 'PAPER' | 'LIVE_MANUAL';
export type PositionSizeMode =
  'MARGIN_USDT' | 'QUANTITY_BTC' | 'NOTIONAL_USDT' | 'MAX_LOSS_USDT';

export interface PositionCalculationInput {
  side: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  target: number;
  leverage?: number;
  sizeMode?: PositionSizeMode;
  sizeValue?: number;
  maxLossUsdt?: number | null;
  accountEquity?: number | null;
  riskPercent?: number | null;
  entryOrderType?: 'MAKER' | 'TAKER';
  exitOrderType?: 'MAKER' | 'TAKER';
  expectedFundingPeriods?: number;
}

export interface PositionCalculationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  quantity: number | null;
  requestedQuantity: number | null;
  notional: number | null;
  isolatedMargin: number | null;
  leverage: number;
  sizeMode: PositionSizeMode;
  sizeValue: number | null;
  breakevenPrice: number | null;
  estimatedLiquidationPrice: number | null;
  liquidationDistancePercent: number | null;
  maximumAllowed: {
    leverage: number | null;
    notional: number | null;
    quantity: number | null;
    margin: number | null;
  };
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

export interface LockedTradePlan {
  id: string;
  mode: TradingMode;
  status: 'LOCKED' | 'ENTERED' | 'PARTIALLY_CLOSED' | 'CLOSED' | 'CANCELLED';
  side: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  targets: number[];
  leverage: number;
  marginMode: 'ISOLATED';
  sizeMode: PositionSizeMode;
  sizeValue: number;
  quantity: number;
  notional: number;
  isolatedMargin: number;
  maxLossUsdt: number | null;
  estimatedMaxLoss: number;
  breakevenPrice: number;
  estimatedLiquidationPrice: number | null;
  entryFeeRate: number;
  exitFeeRate: number;
  entrySlippageBps: number;
  exitSlippageBps: number;
  fundingRate: number;
  expectedFundingPeriods: number;
  snapshotId: string;
  marketGeneratedAt: number;
  monitoring?: ApprovedPlanMonitoring;
  lockedAt: number;
}

export interface LockTradePlanInput extends PositionCalculationInput {
  targets?: number[];
  trigger?: StructuredTriggerInput;
}

export interface PaperTrade {
  id: string;
  planId: string;
  status: 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED';
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  initialQuantity: number;
  remainingQuantity: number;
  leverage: number;
  isolatedMargin: number;
  openedAt: number;
  closedAt: number | null;
  realizedGrossPnl: number;
  feesPaid: number;
  slippagePaid: number;
  fundingPaid: number;
  realizedNetPnl: number;
  lastMarkPrice: number;
  updatedAt: number;
}

export type LiveTradeAttribution =
  | 'OBSERVED_FROM_FLAT'
  | 'INFERRED_FROM_RECENT_TRADES'
  | 'OBSERVED_AFTER_CONNECT';

export interface LiveTradeSession {
  id: string;
  planId: string | null;
  status: 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED';
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  initialQuantity: number;
  peakQuantity: number;
  remainingQuantity: number;
  leverage: number;
  isolatedMargin: number;
  openedAt: number;
  closedAt: number | null;
  realizedGrossPnl: number;
  feesPaid: number | null;
  commissionByAsset: Record<string, number>;
  realizedNetPnl: number | null;
  unrealizedPnl: number;
  lastMarkPrice: number;
  observedTradeIds: string[];
  attribution: LiveTradeAttribution;
  updatedAt: number;
}

export interface ProtectiveCoverage {
  stopLossQuantity: number;
  takeProfitQuantity: number;
  stopLossCoverageRatio: number | null;
  takeProfitCoverageRatio: number | null;
  hasFullStopCoverage: boolean;
  hasFullTakeProfitCoverage: boolean;
}

export interface PaperCloseInput {
  quantity?: number;
  exitPrice?: number;
}

export interface TradingStatistics {
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  averageNetPnl: number | null;
  profitFactor: number | null;
  maxDrawdown: number | null;
}

export type TradeLifecycleStage =
  | 'FLAT'
  | 'WATCHING'
  | 'REANALYSIS_REQUIRED'
  | 'ENTRY_READY'
  | 'MANAGING'
  | 'CLOSED'
  | 'CANCELLED';

export interface TradeLifecycle {
  stage: TradeLifecycleStage;
  mode: TradingMode;
  planId: string | null;
  tradeId: string | null;
  positionSource: 'NONE' | 'PAPER' | 'BINANCE_READ_ONLY';
  startedAt: number | null;
  updatedAt: number;
  blockedReasons: string[];
}

export interface TradingState {
  mode: TradingMode;
  lifecycle: TradeLifecycle;
  activePlan: LockedTradePlan | null;
  lastPlan: LockedTradePlan | null;
  activePaperTrade: PaperTrade | null;
  lastCompletedPaperTrade: PaperTrade | null;
  activeLiveTrade: LiveTradeSession | null;
  lastCompletedLiveTrade: LiveTradeSession | null;
  statistics: TradingStatistics;
  liveManual: {
    available: boolean;
    blockedReasons: string[];
    position: AccountStatus['position'];
    protectiveOrders: AccountStatus['openOrders'];
    protectiveCoverage: ProtectiveCoverage;
    recentTrades: AccountStatus['recentTrades'];
    currentTrade: LiveTradeSession | null;
    lastCompletedTrade: LiveTradeSession | null;
    realizedPnl: number | null;
    planMatchesPosition: boolean | null;
  };
}

export type RelaySanitizedTrade = Omit<
  AccountStatus['recentTrades'][number],
  'orderId'
>;

export type RelayCompactSnapshot = Omit<
  MarketSnapshot,
  'account' | 'trading'
> & {
  account: Omit<MarketSnapshot['account'], 'recentTrades'> & {
    recentTrades: RelaySanitizedTrade[];
  };
  trading: Omit<TradingState, 'liveManual'> & {
    liveManual: Omit<TradingState['liveManual'], 'recentTrades'> & {
      recentTrades: RelaySanitizedTrade[];
    };
  };
};

export interface DesktopApi {
  getPhaseZeroStatus(): Promise<PhaseZeroStatus>;
  testNotification(): Promise<ActionResult>;
  copyText(text: string): Promise<ActionResult>;
  openExternal(url: string): Promise<ActionResult>;
  writeDbCheck(input: WriteDatabaseCheckInput): Promise<DatabaseCheck>;
  readDbCheck(): Promise<DatabaseCheck>;
  getMarketStatus(): Promise<MarketStatus>;
  getLatestSnapshot(): Promise<MarketSnapshot>;
  getLatestCompactSnapshot?(): Promise<RelayCompactSnapshot>;
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
  lockTradePlan?(input: LockTradePlanInput): Promise<LockedTradePlan>;
  getTradingState?(): Promise<TradingState>;
  enterPaperTrade?(): Promise<PaperTrade>;
  partiallyClosePaperTrade?(input: PaperCloseInput): Promise<PaperTrade>;
  closePaperTrade?(input: PaperCloseInput): Promise<PaperTrade>;
  configureRelay(input: RelayConfigurationInput): Promise<ActionResult>;
  disconnectRelay(): Promise<ActionResult>;
  resetLocalData(): Promise<ActionResult>;
  configureNaver?(input: {
    clientId: string;
    clientSecret: string;
  }): Promise<ActionResult>;
  disconnectNaver?(): Promise<ActionResult>;
}
