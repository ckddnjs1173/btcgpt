import { randomUUID } from 'node:crypto';

import type {
  AccountStatus,
  DataStatus,
  ManualPosition,
  MarketSnapshot,
  RiskContext,
  TimeframeSnapshot,
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
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
} as const;
const PERIODS_PER_YEAR: Record<Timeframe, number> = {
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

export function generateSnapshot(
  cache: MarketCache,
  options: SnapshotOptions = {},
): MarketSnapshot {
  const generatedAt = Date.now();
  const sourceHealth = cache.sourceHealth(generatedAt);
  const health = cache.health(generatedAt);
  const missingFields: string[] = [];
  for (const [field, value] of [
    ['marketState.lastPrice', cache.state.lastPrice],
    ['marketState.markPrice', cache.state.markPrice],
    ['marketState.indexPrice', cache.state.indexPrice],
    ['marketState.bidPrice', cache.state.bidPrice],
    ['marketState.askPrice', cache.state.askPrice],
    ['openInterest.current', cache.state.openInterest],
  ] as const)
    if (value === null) missingFields.push(field);
  if (cache.depth.bids.length === 0 || cache.depth.asks.length === 0)
    missingFields.push('orderFlow.depth');
  if (cache.productFilters === null) missingFields.push('productFilters');
  for (const timeframe of TIMEFRAMES)
    if (cache.getClosed(timeframe).length < 250)
      missingFields.push(`timeframes.${timeframe}.closed`);
  const clockSkew = Math.abs((options.serverTime ?? generatedAt) - generatedAt);
  if (clockSkew > 10_000) missingFields.push('binanceServerTime.clockSkew');
  const analysisAllowed =
    health.status === 'NORMAL' && missingFields.length === 0;
  const reasons = [
    health.status !== 'NORMAL' ? `DATA_${health.status}` : null,
    missingFields.length ? 'REQUIRED_DATA_MISSING' : null,
    clockSkew > 10_000 ? 'SYSTEM_CLOCK_SKEW' : null,
  ].filter((reason): reason is string => reason !== null);

  const orderFlowWindows = Object.fromEntries(
    Object.entries(WINDOW_MS).map(([label, windowMs]) => {
      const trades = cache.getTrades(windowMs, generatedAt);
      const takerBuyVolume = trades
        .filter((trade) => !trade.buyerIsMaker)
        .reduce((sum, trade) => sum + trade.quantity, 0);
      const takerSellVolume = trades
        .filter((trade) => trade.buyerIsMaker)
        .reduce((sum, trade) => sum + trade.quantity, 0);
      const total = takerBuyVolume + takerSellVolume;
      return [
        label,
        {
          takerBuyVolume,
          takerSellVolume,
          buyRatio: total > 0 ? takerBuyVolume / total : null,
          sellRatio: total > 0 ? takerSellVolume / total : null,
          delta: takerBuyVolume - takerSellVolume,
          cumulativeDelta: takerBuyVolume - takerSellVolume,
          tradeCount: trades.length,
          averageTradeSize: trades.length > 0 ? total / trades.length : null,
        },
      ];
    }),
  ) as Pick<MarketSnapshot['orderFlow'], '1m' | '5m' | '15m' | '1h'>;
  const bidNotional20 = cache.depth.bids
    .slice(0, 20)
    .reduce((sum, [price, quantity]) => sum + price * quantity, 0);
  const askNotional20 = cache.depth.asks
    .slice(0, 20)
    .reduce((sum, [price, quantity]) => sum + price * quantity, 0);
  const liquidationSummary = Object.fromEntries(
    Object.entries(WINDOW_MS).map(([label, windowMs]) => {
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
  const position = options.position ?? {
    source: 'NONE' as const,
    side: 'FLAT' as const,
    updatedAt: null,
  };
  const snapshot: MarketSnapshot = {
    schemaVersion: 2,
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
    analysisGate: {
      analysisAllowed,
      overallStatus: health.status,
      generatedAt,
      publishedAt: options.publishedAt ?? null,
      ageMs: finiteAge(health.ageMs),
      reasons,
      missingFields,
    },
    strategy: {
      leverage: 10,
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
