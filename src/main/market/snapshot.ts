import { randomUUID } from 'node:crypto';

import type {
  AccountStatus,
  DataStatus,
  ManualPosition,
  MarketSnapshot,
  RiskContext,
  TimeframeSnapshot,
  TradingState,
} from '../../shared/contracts';
import { ema } from '../../shared/calculations/ema';
import { rsi } from '../../shared/calculations/rsi';
import {
  atr,
  confirmedPivots,
  estimateSlippage,
  orderBookImbalance,
  percentageChange,
  realizedVolatility,
  recentExtremes,
  sma,
  volumeZScore,
  vwap,
} from '../../shared/calculations/market';
import type { MarketCache } from './cache';
import {
  REFERENCE_TIMEFRAMES,
  TIMEFRAMES,
  type Candle,
  type Timeframe,
} from './types';

const FIELDS = [
  'openTime',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'takerBuyVolume',
  'tradeCount',
] as const;
const WINDOW_MS = {
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
} as const;
const LIQUIDATION_WINDOW_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
} as const;
const PERIODS_PER_YEAR: Record<Timeframe, number> = {
  '1m': 365 * 24 * 60,
  '5m': 365 * 24 * 12,
  '15m': 365 * 24 * 4,
  '1h': 365 * 24,
  '4h': 365 * 6,
  '1d': 365,
  '1w': 52,
};

export interface SnapshotOptions {
  serverTime?: number;
  position?: AccountStatus['position'] | ManualPosition | null;
  accountStatus?: AccountStatus | null;
  makerFeeRate?: number | null;
  takerFeeRate?: number | null;
  entrySlippageBps?: number | null;
  exitSlippageBps?: number | null;
  maxLossUsdt?: number | null;
  riskPercent?: number | null;
  riskContext?: RiskContext;
  publishedAt?: number | null;
  defaultLeverage?: number;
  tradingState?: TradingState;
}

function row(candle: Candle): unknown[] {
  return [
    candle.openTime,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
    candle.takerBuyBaseVolume,
    candle.tradeCount,
  ];
}

function returnOver(closes: number[], periods: number): number | null {
  if (closes.length <= periods) return null;
  return percentageChange(closes.at(-1) ?? 0, closes.at(-(periods + 1)) ?? 0);
}

function indicators(
  candles: Candle[],
  timeframe: Timeframe,
): TimeframeSnapshot['indicators'] {
  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const volumes = candles.map((candle) => candle.volume);
  const latestClose = closes.at(-1) ?? null;
  const atr14 = atr(candles, 14);
  const volumeSma20 = sma(volumes, 20);
  const extremes20 = recentExtremes([...highs, ...lows], 20);
  const high20 =
    highs.length >= 20 ? Math.max(...highs.slice(-20)) : extremes20.high;
  const low20 =
    lows.length >= 20 ? Math.min(...lows.slice(-20)) : extremes20.low;
  const high50 = highs.length >= 50 ? Math.max(...highs.slice(-50)) : null;
  const low50 = lows.length >= 50 ? Math.min(...lows.slice(-50)) : null;
  const pivots = confirmedPivots(highs, lows);
  const latestDay = candles.at(-1)
    ? new Date(candles.at(-1)!.openTime).toISOString().slice(0, 10)
    : null;
  const sessionCandles = latestDay
    ? candles.filter(
        (candle) =>
          new Date(candle.openTime).toISOString().slice(0, 10) === latestDay,
      )
    : [];
  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    atr14,
    atrPercent:
      atr14 !== null && latestClose ? (atr14 / latestClose) * 100 : null,
    volumeSma20,
    volumeRatio:
      volumeSma20 && volumes.at(-1) !== undefined
        ? (volumes.at(-1) ?? 0) / volumeSma20
        : null,
    volumeZScore: volumeZScore(volumes),
    vwap: vwap(sessionCandles),
    high20,
    low20,
    high50,
    low50,
    pivotHigh: pivots.high,
    pivotLow: pivots.low,
    return1: returnOver(closes, 1),
    return3: returnOver(closes, 3),
    return12: returnOver(closes, 12),
    realizedVolatility: realizedVolatility(
      closes.slice(-50),
      PERIODS_PER_YEAR[timeframe],
    ),
  };
}

function buildTimeframe(
  cache: MarketCache,
  timeframe: Timeframe,
  status: DataStatus,
): TimeframeSnapshot {
  const allClosed = cache.getClosed(timeframe);
  const closed = allClosed.slice(-120);
  const live = cache.getLive(timeframe);
  const combined = live ? [...allClosed, live] : allClosed;
  return {
    fields: [...FIELDS],
    closed: closed.map(row),
    live: live ? row(live) : null,
    indicators: indicators(allClosed, timeframe),
    liveIndicators: live
      ? {
          ema20: ema(
            combined.map((candle) => candle.close),
            20,
          ),
          vwap: vwap(combined),
        }
      : null,
    status,
  };
}

function finiteAge(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : -1;
}

function percentageFromSamples(
  samples: Array<{ observedAt: number; value: number }>,
  expectedWindowMs: number,
): number | null {
  if (samples.length < 2) return null;
  const firstObservedAt = samples[0]?.observedAt;
  const lastObservedAt = samples.at(-1)?.observedAt;
  if (
    firstObservedAt === undefined ||
    lastObservedAt === undefined ||
    lastObservedAt - firstObservedAt < expectedWindowMs * 0.8
  )
    return null;
  const first = samples[0]?.value;
  const last = samples.at(-1)?.value;
  if (first === undefined || last === undefined || first === 0) return null;
  return ((last - first) / first) * 100;
}

function candleStructure(
  cache: MarketCache,
  timeframe: '1m' | '5m',
  now: number,
): MarketSnapshot['scalpContext']['candles']['1m'] {
  const closed = cache.getClosed(timeframe);
  const live = cache.getLive(timeframe);
  const selected = live ?? closed.at(-1) ?? null;
  const range = selected ? selected.high - selected.low : 0;
  const body = selected ? Math.abs(selected.close - selected.open) : 0;
  const upperWick = selected
    ? selected.high - Math.max(selected.open, selected.close)
    : 0;
  const lowerWick = selected
    ? Math.min(selected.open, selected.close) - selected.low
    : 0;
  const closes = closed.map((candle) => candle.close);
  const latestEma = ema(closes, 20);
  const previousEma = ema(closes.slice(0, -1), 20);
  const timeframeIndicators = indicators(closed, timeframe);
  const selectedPrice = selected?.close ?? null;
  const ranges = (candles: Candle[]) =>
    candles.length
      ? Math.max(...candles.map((candle) => candle.high)) -
        Math.min(...candles.map((candle) => candle.low))
      : null;
  const range5 = closed.length >= 5 ? ranges(closed.slice(-5)) : null;
  const range20 = closed.length >= 20 ? ranges(closed.slice(-20)) : null;
  const progressRatio = live
    ? Math.min(
        1,
        Math.max(0, (now - live.openTime) / (live.closeTime - live.openTime)),
      )
    : null;
  return {
    closedAt: closed.at(-1)?.closeTime ?? null,
    liveObservedAt: live?.receivedAt ?? null,
    progressRatio,
    bodyRatio: range > 0 ? body / range : null,
    upperWickRatio: range > 0 ? upperWick / range : null,
    lowerWickRatio: range > 0 ? lowerWick / range : null,
    closeLocation:
      range > 0 && selected ? (selected.close - selected.low) / range : null,
    ema20SlopePerCandle:
      latestEma !== null && previousEma !== null ? latestEma - previousEma : null,
    vwapDistanceBps:
      selectedPrice !== null && timeframeIndicators.vwap
        ? ((selectedPrice - timeframeIndicators.vwap) /
            timeframeIndicators.vwap) *
          10_000
        : null,
    pivotHighDistanceAtr:
      selectedPrice !== null &&
      timeframeIndicators.pivotHigh !== null &&
      timeframeIndicators.atr14
        ? (timeframeIndicators.pivotHigh - selectedPrice) /
          timeframeIndicators.atr14
        : null,
    pivotLowDistanceAtr:
      selectedPrice !== null &&
      timeframeIndicators.pivotLow !== null &&
      timeframeIndicators.atr14
        ? (selectedPrice - timeframeIndicators.pivotLow) /
          timeframeIndicators.atr14
        : null,
    rangeCompression5vs20:
      range5 !== null && range20 ? range5 / range20 : null,
    liveVolumeRatio:
      live && progressRatio && timeframeIndicators.volumeSma20
        ? live.volume /
          progressRatio /
          timeframeIndicators.volumeSma20
        : null,
    volumeZScore: timeframeIndicators.volumeZScore,
    abovePivotHigh:
      selectedPrice !== null && timeframeIndicators.pivotHigh !== null
        ? selectedPrice > timeframeIndicators.pivotHigh
        : null,
    belowPivotLow:
      selectedPrice !== null && timeframeIndicators.pivotLow !== null
        ? selectedPrice < timeframeIndicators.pivotLow
        : null,
  };
}

export function generateSnapshot(
  cache: MarketCache,
  options: SnapshotOptions = {},
): MarketSnapshot {
  const generatedAt = Date.now();
  const sourceHealth = cache.sourceHealth(generatedAt);
  const health = cache.health(generatedAt);
  const position = options.position ?? {
    source: 'NONE' as const,
    side: 'FLAT' as const,
    updatedAt: null,
  };
  const hasOpenPosition =
    position.side !== 'FLAT' || options.tradingState?.activePaperTrade != null;
  const isUnavailable = (source: string): boolean => {
    const status = sourceHealth[source]?.status ?? 'INSUFFICIENT_DATA';
    return (
      status === 'STALE' ||
      status === 'DISCONNECTED' ||
      status === 'INSUFFICIENT_DATA'
    );
  };
  const degradedSources = Object.entries(sourceHealth)
    .filter(([, source]) => source.status !== 'NORMAL')
    .map(([source, state]) => `${source}:${state.status}`);

  const marketMissingFields: string[] = [];
  for (const [field, value] of [
    ['marketState.lastPrice', cache.state.lastPrice],
    ['marketState.markPrice', cache.state.markPrice],
    ['marketState.bidPrice', cache.state.bidPrice],
    ['marketState.askPrice', cache.state.askPrice],
  ] as const)
    if (value === null) marketMissingFields.push(field);
  if (cache.getClosed('1m').length < 20)
    marketMissingFields.push('timeframes.1m.closed');
  if (cache.getClosed('5m').length < 20)
    marketMissingFields.push('timeframes.5m.closed');
  if (cache.getTrades(60_000, generatedAt).length === 0)
    marketMissingFields.push('orderFlow.trades');

  const entryMissingFields = [...marketMissingFields];
  if (cache.state.indexPrice === null)
    entryMissingFields.push('marketState.indexPrice');
  if (cache.state.openInterest === null)
    entryMissingFields.push('openInterest.current');
  if (cache.depth.bids.length === 0 || cache.depth.asks.length === 0)
    entryMissingFields.push('orderFlow.depth');
  if (cache.productFilters === null) entryMissingFields.push('productFilters');
  for (const timeframe of ['1m', '5m', '15m', '1h'] as const)
    if (cache.getClosed(timeframe).length < 200)
      entryMissingFields.push(`timeframes.${timeframe}.closed`);

  const clockSkew = Math.abs((options.serverTime ?? generatedAt) - generatedAt);
  if (clockSkew > 10_000) {
    marketMissingFields.push('binanceServerTime.clockSkew');
    entryMissingFields.push('binanceServerTime.clockSkew');
  }

  const marketCriticalSources = [
    'market',
    'bookTicker',
    'trades',
    'candle:1m',
    'candle:5m',
  ];
  const entryCriticalSources = [
    ...marketCriticalSources,
    'depth',
    'openInterest',
    'candle:15m',
    'candle:1h',
  ];
  const marketAnalysisAvailable =
    marketMissingFields.length === 0 &&
    !marketCriticalSources.some(isUnavailable);
  const entryAllowed =
    entryMissingFields.length === 0 &&
    !entryCriticalSources.some(isUnavailable);

  const accountAgeMs =
    options.accountStatus?.lastUpdatedAt === null ||
    options.accountStatus?.lastUpdatedAt === undefined
      ? Number.POSITIVE_INFINITY
      : generatedAt - options.accountStatus.lastUpdatedAt;
  const positionManagementMissingFields: string[] = [];
  if (cache.state.markPrice === null)
    positionManagementMissingFields.push('marketState.markPrice');
  if (
    hasOpenPosition &&
    position.source === 'BINANCE' &&
    (!options.accountStatus?.connected || accountAgeMs > 15_000)
  )
    positionManagementMissingFields.push('account.position');
  const positionManagementAvailable =
    positionManagementMissingFields.length === 0 &&
    (sourceHealth.market?.ageMs ?? Number.POSITIVE_INFINITY) <= 15_000;

  const criticalBlockers = [
    !marketAnalysisAvailable ? 'MARKET_ANALYSIS_DATA_UNAVAILABLE' : null,
    !entryAllowed ? 'ENTRY_DATA_UNAVAILABLE' : null,
    hasOpenPosition && !positionManagementAvailable
      ? 'POSITION_MANAGEMENT_DATA_UNAVAILABLE'
      : null,
    clockSkew > 10_000 ? 'SYSTEM_CLOCK_SKEW' : null,
  ].filter((reason): reason is string => reason !== null);
  const quality =
    entryAllowed && degradedSources.length === 0
      ? ('GREEN' as const)
      : marketAnalysisAvailable || positionManagementAvailable
        ? ('YELLOW' as const)
        : ('RED' as const);
  const gateStatus: DataStatus =
    quality === 'GREEN'
      ? 'NORMAL'
      : quality === 'YELLOW'
        ? 'DELAYED'
        : health.status;

  const orderFlowWindows = Object.fromEntries(
    Object.entries(WINDOW_MS).map(([label, windowMs]) => {
      const trades = cache.getTrades(windowMs, generatedAt);
      const previousTrades = cache
        .getTrades(windowMs * 2, generatedAt)
        .filter((trade) => trade.eventTime < generatedAt - windowMs);
      const takerBuyVolume = trades
        .filter((trade) => !trade.buyerIsMaker)
        .reduce((sum, trade) => sum + trade.quantity, 0);
      const takerSellVolume = trades
        .filter((trade) => trade.buyerIsMaker)
        .reduce((sum, trade) => sum + trade.quantity, 0);
      const total = takerBuyVolume + takerSellVolume;
      const buyTradeCount = trades.filter(
        (trade) => !trade.buyerIsMaker,
      ).length;
      const sellTradeCount = trades.length - buyTradeCount;
      const previousBuy = previousTrades
        .filter((trade) => !trade.buyerIsMaker)
        .reduce((sum, trade) => sum + trade.quantity, 0);
      const previousSell = previousTrades
        .filter((trade) => trade.buyerIsMaker)
        .reduce((sum, trade) => sum + trade.quantity, 0);
      const durationSeconds = windowMs / 1_000;
      return [
        label,
        {
          windowStart: generatedAt - windowMs,
          windowEnd: generatedAt,
          sampleCount: trades.length,
          takerBuyVolume,
          takerSellVolume,
          buyRatio: total > 0 ? takerBuyVolume / total : null,
          sellRatio: total > 0 ? takerSellVolume / total : null,
          delta: takerBuyVolume - takerSellVolume,
          cumulativeDelta: takerBuyVolume - takerSellVolume,
          tradeCount: trades.length,
          buyTradeCount,
          sellTradeCount,
          averageTradeSize: trades.length > 0 ? total / trades.length : null,
          tradesPerSecond: trades.length / durationSeconds,
          notionalPerSecond:
            trades.reduce(
              (sum, trade) => sum + trade.price * trade.quantity,
              0,
            ) / durationSeconds,
          deltaChangeFromPreviousWindow:
            previousTrades.length > 0
              ? takerBuyVolume -
                takerSellVolume -
                (previousBuy - previousSell)
              : null,
        },
      ];
    }),
  ) as Pick<
    MarketSnapshot['orderFlow'],
    '15s' | '30s' | '1m' | '3m' | '5m' | '15m' | '1h'
  >;
  const bidNotional20 = cache.depth.bids
    .slice(0, 20)
    .reduce((sum, [price, quantity]) => sum + price * quantity, 0);
  const askNotional20 = cache.depth.asks
    .slice(0, 20)
    .reduce((sum, [price, quantity]) => sum + price * quantity, 0);
  const liquidationSummary = Object.fromEntries(
    Object.entries(LIQUIDATION_WINDOW_MS).map(([label, windowMs]) => {
      const events = cache.getLiquidations(windowMs, generatedAt);
      const longNotional = events
        .filter((event) => event.side === 'SELL')
        .reduce((sum, event) => sum + event.notional, 0);
      const shortNotional = events
        .filter((event) => event.side === 'BUY')
        .reduce((sum, event) => sum + event.notional, 0);
      return [
        label,
        {
          longNotional,
          shortNotional,
          netNotional: shortNotional - longNotional,
          eventCount: events.length,
        },
      ];
    }),
  ) as MarketSnapshot['liquidations'];
  const mark = cache.state.markPrice;
  const index = cache.state.indexPrice;
  const bid = cache.state.bidPrice;
  const ask = cache.state.askPrice;
  const spread = bid !== null && ask !== null ? ask - bid : null;
  const depth5s = cache.getDepthSamples(5_000, generatedAt);
  const depth30s = cache.getDepthSamples(30_000, generatedAt);
  const latestDepth = depth30s.at(-1) ?? null;
  const imbalanceChange = (
    samples: ReturnType<MarketCache['getDepthSamples']>,
  ) => {
    const first = samples[0]?.imbalance20;
    const last = samples.at(-1)?.imbalance20;
    return first !== null &&
      first !== undefined &&
      last !== null &&
      last !== undefined &&
      samples.length >= 2
      ? last - first
      : null;
  };
  const wallPersistence = (
    side: 'bid' | 'ask',
    samples: ReturnType<MarketCache['getDepthSamples']>,
  ) => {
    const price =
      side === 'bid' ? latestDepth?.bidWallPrice : latestDepth?.askWallPrice;
    if (price === null || price === undefined || samples.length === 0)
      return null;
    const matches = samples.filter(
      (sample) =>
        (side === 'bid' ? sample.bidWallPrice : sample.askWallPrice) === price,
    ).length;
    return matches / samples.length;
  };
  const oi1m = cache.getOpenInterestSamples(60_000, generatedAt);
  const oi5m = cache.getOpenInterestSamples(5 * 60_000, generatedAt);
  const sourceHealthSnapshot = Object.fromEntries(
    Object.entries(sourceHealth).map(([source, state]) => [
      source,
      {
        status: state.status,
        eventTime: state.eventTime,
        receivedTime: state.receivedTime,
        ageMs: finiteAge(state.ageMs),
        lastSuccess: state.lastSuccess,
        consecutiveFailures: state.consecutiveFailures,
        reconnectCount: state.reconnectCount,
        validationError: state.validationError,
      },
    ]),
  );
  const snapshot: MarketSnapshot = {
    schemaVersion: 5,
    snapshotId: randomUUID(),
    symbol: 'BTCUSDT',
    market: 'BINANCE_USDM_PERPETUAL',
    generatedAt,
    generatedAtKst: new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul',
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(generatedAt),
    binanceServerTime: options.serverTime ?? generatedAt,
    decisionGates: {
      marketAnalysisAvailable,
      entryAllowed,
      positionManagementAvailable,
      quality,
      generatedAt,
      publishedAt: options.publishedAt ?? null,
      ageMs: finiteAge(health.ageMs),
      criticalBlockers,
      degradedSources,
      missingFields: [...new Set([
        ...marketMissingFields,
        ...entryMissingFields,
        ...positionManagementMissingFields,
      ])],
    },
    analysisGate: {
      analysisAllowed: entryAllowed,
      overallStatus: gateStatus,
      generatedAt,
      publishedAt: options.publishedAt ?? null,
      ageMs: finiteAge(health.ageMs),
      reasons: criticalBlockers,
      missingFields: entryMissingFields,
    },
    strategy: {
      leverage:
        options.tradingState?.activePlan?.leverage ??
        options.defaultLeverage ??
        10,
      marginMode: 'ISOLATED',
      minimumNetMarginRoiPercent: 2,
      maxLossUsdt: options.maxLossUsdt ?? null,
      riskPercent: options.riskPercent ?? null,
    },
    marketState: {
      lastPrice: cache.state.lastPrice,
      markPrice: mark,
      indexPrice: index,
      bidPrice: bid,
      askPrice: ask,
      spread,
      spreadBps: spread !== null && mark ? (spread / mark) * 10_000 : null,
      fundingRate: cache.state.fundingRate,
      nextFundingTime: cache.state.nextFundingTime,
      basis: mark !== null && index !== null ? mark - index : null,
      basisPercent:
        mark !== null && index ? ((mark - index) / index) * 100 : null,
      priceChangePercent24h: cache.state.priceChangePercent24h,
      highPrice24h: cache.state.highPrice24h,
      lowPrice24h: cache.state.lowPrice24h,
      volume24h: cache.state.volume24h,
      quoteVolume24h: cache.state.quoteVolume24h,
    },
    orderFlow: {
      ...orderFlowWindows,
      orderBookImbalance5: orderBookImbalance(
        cache.depth.bids,
        cache.depth.asks,
        5,
      ),
      orderBookImbalance10: orderBookImbalance(
        cache.depth.bids,
        cache.depth.asks,
        10,
      ),
      orderBookImbalance20: orderBookImbalance(
        cache.depth.bids,
        cache.depth.asks,
        20,
      ),
      bidNotional20,
      askNotional20,
      estimatedSlippage: {
        '0.01btc': {
          buyBps:
            estimateSlippage('BUY', 0.01, cache.depth.asks)?.slippageBps ??
            null,
          sellBps:
            estimateSlippage('SELL', 0.01, cache.depth.bids)?.slippageBps ??
            null,
        },
        '0.1btc': {
          buyBps:
            estimateSlippage('BUY', 0.1, cache.depth.asks)?.slippageBps ?? null,
          sellBps:
            estimateSlippage('SELL', 0.1, cache.depth.bids)?.slippageBps ??
            null,
        },
      },
    },
    openInterest: {
      current: cache.state.openInterest,
      notional:
        cache.state.openInterest !== null && mark !== null
          ? cache.state.openInterest * mark
          : null,
      changes: cache.sentiment.openInterestChanges,
      localChanges: {
        '1m': percentageFromSamples(oi1m, 60_000),
        '5m': percentageFromSamples(oi5m, 5 * 60_000),
        sampleCount1m: oi1m.length,
        sampleCount5m: oi5m.length,
        observedAt: oi5m.at(-1)?.observedAt ?? null,
      },
    },
    sentiment: {
      globalLongShortAccountRatio: cache.sentiment.globalLongShortAccountRatio,
      topLongShortAccountRatio: cache.sentiment.topLongShortAccountRatio,
      topLongShortPositionRatio: cache.sentiment.topLongShortPositionRatio,
      takerBuySellRatio: cache.sentiment.takerBuySellRatio,
      updatedAt: cache.sentiment.updatedAt,
    },
    liquidations: liquidationSummary,
    position,
    account: {
      connected: options.accountStatus?.connected ?? false,
      lastUpdatedAt: options.accountStatus?.lastUpdatedAt ?? null,
      availableBalance:
        options.accountStatus?.balance?.availableBalance ?? null,
      commission: options.accountStatus?.commission ?? null,
      openOrders: options.accountStatus?.openOrders ?? [],
      recentTrades: options.accountStatus?.recentTrades ?? [],
      leverageBrackets: options.accountStatus?.leverageBrackets ?? [],
    },
    costSettings: {
      makerFeeRate: options.makerFeeRate ?? null,
      takerFeeRate: options.takerFeeRate ?? null,
      entrySlippageBps: options.entrySlippageBps ?? null,
      exitSlippageBps: options.exitSlippageBps ?? null,
    },
    productFilters: cache.productFilters,
    sourceHealth: sourceHealthSnapshot,
    timeframes: Object.fromEntries(
      [...TIMEFRAMES, ...REFERENCE_TIMEFRAMES].map((timeframe) => [
        timeframe,
        buildTimeframe(
          cache,
          timeframe,
          sourceHealth[`candle:${timeframe}`]?.status ??
            (cache.getClosed(timeframe).length >= 200
              ? 'NORMAL'
              : 'INSUFFICIENT_DATA'),
        ),
      ]),
    ) as MarketSnapshot['timeframes'],
    riskContext: options.riskContext ?? {
      status: 'UNAVAILABLE',
      updatedAt: null,
      highRiskNews: false,
      representativeEventId: null,
      nextMacroEvent: null,
      binanceCriticalNotice: false,
      optionsVolatilityState: null,
      onchainAnomaly: false,
      fearAndGreed: null,
      sourceWarnings: ['EXTERNAL_CONTEXT_UNAVAILABLE'],
    },
    scalpContext: {
      generatedAt,
      candles: {
        '1m': candleStructure(cache, '1m', generatedAt),
        '5m': candleStructure(cache, '5m', generatedAt),
      },
      depth: {
        observedAt: latestDepth?.observedAt ?? null,
        sampleCount5s: depth5s.length,
        sampleCount30s: depth30s.length,
        imbalanceChange5s: imbalanceChange(depth5s),
        imbalanceChange30s: imbalanceChange(depth30s),
        bidDominanceRatio5s:
          depth5s.length > 0
            ? depth5s.filter(
                (sample) =>
                  sample.imbalance20 !== null && sample.imbalance20 > 0,
              ).length / depth5s.length
            : null,
        bidWallPrice: latestDepth?.bidWallPrice ?? null,
        bidWallNotional: latestDepth?.bidWallNotional ?? null,
        askWallPrice: latestDepth?.askWallPrice ?? null,
        askWallNotional: latestDepth?.askWallNotional ?? null,
        bidWallPersistence5s: wallPersistence('bid', depth5s),
        askWallPersistence5s: wallPersistence('ask', depth5s),
      },
    },
    trading: options.tradingState ?? {
      mode: 'PAPER',
      lifecycle: {
        stage: 'FLAT',
        mode: 'PAPER',
        planId: null,
        tradeId: null,
        positionSource: 'NONE',
        startedAt: null,
        updatedAt: generatedAt,
        blockedReasons: ['TRADING_STATE_UNAVAILABLE'],
      },
      activePlan: null,
      activePaperTrade: null,
      lastCompletedPaperTrade: null,
      statistics: {
        closedTrades: 0,
        wins: 0,
        losses: 0,
        winRate: null,
        grossProfit: 0,
        grossLoss: 0,
        netPnl: 0,
        averageNetPnl: null,
        profitFactor: null,
        maxDrawdown: null,
      },
      liveManual: {
        available: false,
        blockedReasons: ['TRADING_STATE_UNAVAILABLE'],
        position: null,
        protectiveOrders: [],
        recentTrades: [],
        realizedPnl: null,
        planMatchesPosition: null,
      },
    },
  };
  if (
    new TextEncoder().encode(JSON.stringify(snapshot.riskContext)).byteLength >
    2_048
  ) {
    snapshot.riskContext = {
      ...snapshot.riskContext,
      sourceWarnings: snapshot.riskContext.sourceWarnings.slice(0, 5),
    };
  }
  const size = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  if (size > 90_000)
    throw new Error(`Snapshot exceeds the 90000-byte limit: ${size}`);
  return snapshot;
}
