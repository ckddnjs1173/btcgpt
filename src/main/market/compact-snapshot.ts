import type { MarketSnapshot, TimeframeSnapshot } from '../../shared/contracts';

// Keep one kilobyte below the public 90KB action ceiling and match Worker.
export const RELAY_SNAPSHOT_MAX_BYTES = 89_000;

const PRIMARY_CANDLE_LIMITS = {
  '1m': 60,
  '3m': 48,
  '5m': 60,
  '15m': 40,
  '30m': 36,
  '1h': 32,
  '4h': 32,
  '1d': 20,
  '1w': 20,
} as const;

const FALLBACK_CANDLE_LIMITS = {
  '1m': 30,
  '3m': 24,
  '5m': 30,
  '15m': 20,
  '30m': 18,
  '1h': 16,
  '4h': 16,
  '1d': 12,
  '1w': 12,
} as const;

const MINIMUM_CANDLE_LIMITS = {
  '1m': 16,
  '3m': 14,
  '5m': 16,
  '15m': 12,
  '30m': 12,
  '1h': 12,
  '4h': 12,
  '1d': 8,
  '1w': 8,
} as const;

type CandleLimits = Record<keyof typeof PRIMARY_CANDLE_LIMITS, number>;

export interface CompactSnapshotResult {
  snapshot: MarketSnapshot;
  json: string;
  byteLength: number;
  sectionBytes: Record<string, number>;
}

function compactTimeframe(
  timeframe: TimeframeSnapshot,
  limit: number,
): TimeframeSnapshot {
  return {
    ...timeframe,
    closed: timeframe.closed.slice(-limit),
  };
}

function sectionByteLengths(
  snapshot: MarketSnapshot,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [
      key,
      Buffer.byteLength(JSON.stringify(value), 'utf8'),
    ]),
  );
}

function buildCompactSnapshot(
  source: MarketSnapshot,
  limits: CandleLimits,
  recentTradeLimit: number,
  orderLimit: number,
): MarketSnapshot {
  return {
    ...source,
    timeframes: {
      '1m': compactTimeframe(source.timeframes['1m'], limits['1m']),
      '3m': compactTimeframe(source.timeframes['3m'], limits['3m']),
      '5m': compactTimeframe(source.timeframes['5m'], limits['5m']),
      '15m': compactTimeframe(source.timeframes['15m'], limits['15m']),
      '30m': compactTimeframe(source.timeframes['30m'], limits['30m']),
      '1h': compactTimeframe(source.timeframes['1h'], limits['1h']),
      '4h': compactTimeframe(source.timeframes['4h'], limits['4h']),
      '1d': compactTimeframe(source.timeframes['1d'], limits['1d']),
      '1w': compactTimeframe(source.timeframes['1w'], limits['1w']),
    },
    account: {
      ...source.account,
      openOrders: source.account.openOrders.slice(-orderLimit),
      recentTrades: source.account.recentTrades.slice(-recentTradeLimit),
    },
    trading: {
      ...source.trading,
      liveManual: {
        ...source.trading.liveManual,
        protectiveOrders:
          source.trading.liveManual.protectiveOrders.slice(-orderLimit),
        recentTrades:
          source.trading.liveManual.recentTrades.slice(-recentTradeLimit),
      },
    },
  };
}

export function createCompactRelaySnapshot(
  fullSnapshot: MarketSnapshot,
): CompactSnapshotResult {
  let snapshot = buildCompactSnapshot(
    fullSnapshot,
    PRIMARY_CANDLE_LIMITS,
    20,
    50,
  );
  let json = JSON.stringify(snapshot);
  let byteLength = Buffer.byteLength(json, 'utf8');

  if (byteLength >= RELAY_SNAPSHOT_MAX_BYTES) {
    snapshot = buildCompactSnapshot(
      fullSnapshot,
      FALLBACK_CANDLE_LIMITS,
      10,
      30,
    );
    json = JSON.stringify(snapshot);
    byteLength = Buffer.byteLength(json, 'utf8');
  }

  if (byteLength >= RELAY_SNAPSHOT_MAX_BYTES) {
    snapshot = buildCompactSnapshot(
      fullSnapshot,
      MINIMUM_CANDLE_LIMITS,
      5,
      20,
    );
    json = JSON.stringify(snapshot);
    byteLength = Buffer.byteLength(json, 'utf8');
  }

  return {
    snapshot,
    json,
    byteLength,
    sectionBytes: sectionByteLengths(snapshot),
  };
}
