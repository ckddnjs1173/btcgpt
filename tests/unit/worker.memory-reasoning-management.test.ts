import { describe, expect, it } from 'vitest';

import type { Env } from '../../worker/src/index';
import { buildMarketFingerprint } from '../../worker/src/phase15-fingerprint';
import { buildCrossMarketContext } from '../../worker/src/phase17-cross-market';
import {
  buildTradingMemory,
  type TradingMemoryContext,
} from '../../worker/src/phase21-memory';
import { buildAdaptiveReasoningPolicy } from '../../worker/src/phase22-reasoning';
import { buildPositionManagementContext } from '../../worker/src/phase23-management';

function fingerprintSnapshot(
  snapshotId: string,
  generatedAt: number,
  shift = 0,
) {
  const mark = 100 + shift;
  const indicators = {
    return1: 0.1 + shift / 100,
    return3: 0.2,
    return12: -0.1,
    atrPercent: 0.5,
    realizedVolatility: 0.7,
    rsi14: 55,
    ema20: mark - 0.2,
    ema50: mark - 0.5,
    ema200: mark - 1,
  };
  return {
    snapshotId,
    generatedAt,
    marketState: {
      markPrice: mark,
      indexPrice: mark - 0.05,
      spreadBps: 0.8,
      fundingRate: 0.0001,
      basisPercent: 0.02,
      priceChangePercent24h: 1.2,
    },
    timeframes: {
      '1m': { indicators },
      '5m': { indicators },
      '15m': { indicators },
      '1h': { indicators },
      '4h': { indicators },
    },
    scalpContext: {
      candles: {
        '1m': {
          bodyRatio: 0.4,
          upperWickRatio: 0.2,
          lowerWickRatio: 0.4,
          closeLocation: 0.7,
          ema20SlopePerCandle: 0.05,
          vwapDistanceBps: 4,
          pivotHighDistanceAtr: 0.8,
          pivotLowDistanceAtr: 1.2,
          rangeCompression5vs20: 0.9,
          volumeZScore: 0.5,
        },
        '5m': {
          bodyRatio: 0.3,
          upperWickRatio: 0.3,
          lowerWickRatio: 0.4,
          closeLocation: 0.6,
          ema20SlopePerCandle: 0.03,
          vwapDistanceBps: 3,
          pivotHighDistanceAtr: 1,
          pivotLowDistanceAtr: 1.1,
          rangeCompression5vs20: 0.8,
          volumeZScore: 0.4,
        },
      },
      depth: {
        imbalanceChange5s: 0.05,
        imbalanceChange30s: 0.1,
        bidDominanceRatio5s: 0.55,
        bidWallNotional: 120,
        askWallNotional: 100,
      },
    },
    orderFlow: {
      '15s': {
        buyRatio: 0.55,
        priceChangeBps: 2,
        tradesPerSecond: 5,
        impactBpsPerBtc: 1,
      },
      '1m': {
        buyRatio: 0.56,
        priceChangeBps: 3,
        tradesPerSecond: 4,
        impactBpsPerBtc: 1.2,
      },
      '5m': {
        buyRatio: 0.54,
        priceChangeBps: 5,
        tradesPerSecond: 3,
        impactBpsPerBtc: 1.5,
      },
      orderBookImbalance20: 0.1,
      orderBookImbalance50: 0.08,
      orderBookImbalance100: 0.05,
      microPrice: mark + 0.01,
    },
    openInterest: {
      notional: 1_000_000,
      localChanges: { '1m': 0.1, '5m': 0.2 },
      changes: { '5m': 0.2, '15m': 0.4, '1h': 0.8, '4h': 1.2 },
    },
    sentiment: {
      globalLongShortAccountRatio: 1.05,
      topLongShortAccountRatio: 1.1,
      topLongShortPositionRatio: 1.08,
      takerBuySellRatio: 1.02,
    },
    liquidations: {
      '1m': { longNotional: 100, shortNotional: 150 },
      '5m': { longNotional: 200, shortNotional: 250 },
      '15m': { longNotional: 300, shortNotional: 350 },
    },
    riskContext: {
      highRiskNews: false,
      binanceCriticalNotice: false,
      onchainAnomaly: false,
      nextMacroEvent: null,
      fearAndGreed: { value: 55 },
    },
  };
}

function fullCrossMarket() {
  const quote = (venue: 'BINANCE_USDM' | 'COINBASE_SPOT', symbol: string) => ({
    venue,
    symbol,
    lastPrice: 100,
    return24hPercent: 1,
    volume24h: 100,
    quoteVolume24h: venue === 'BINANCE_USDM' ? 1_000 : null,
    observedAt: 1_000,
  });
  return buildCrossMarketContext({
    generatedAt: 1_000,
    binance: {
      BTC: quote('BINANCE_USDM', 'BTCUSDT'),
      ETH: quote('BINANCE_USDM', 'ETHUSDT'),
      SOL: quote('BINANCE_USDM', 'SOLUSDT'),
    },
    coinbase: {
      BTC: quote('COINBASE_SPOT', 'BTC-USD'),
      ETH: quote('COINBASE_SPOT', 'ETH-USD'),
      SOL: quote('COINBASE_SPOT', 'SOL-USD'),
    },
  });
}

describe('Phase 21-23 intelligence', () => {
  it('retrieves only finalized historical analogs and ranks a close fingerprint', async () => {
    const current = fingerprintSnapshot('current', 10_000, 0);
    const historical = buildMarketFingerprint(
      fingerprintSnapshot('historical', 5_000, 0.05),
    );
    expect(historical).not.toBeNull();

    let query = '';
    let bound: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        bound = values;
        return this;
      },
      all() {
        return Promise.resolve({
          success: true,
          results: [
            {
              decisionId: 'decision-old',
              marketGeneratedAt: 5_000,
              fingerprintPayload: JSON.stringify(historical),
              decision: 'WAIT_TRIGGER',
              side: 'NEUTRAL',
              confidenceBand: 'MEDIUM',
              returnBps5m: 5,
              maxUpBps5m: 10,
              maxDownBps5m: -4,
              returnBps15m: 8,
              maxUpBps15m: 16,
              maxDownBps15m: -7,
              returnBps30m: 12,
              maxUpBps30m: 22,
              maxDownBps30m: -9,
              returnBps60m: 15,
              maxUpBps60m: 30,
              maxDownBps60m: -12,
            },
          ],
        });
      },
    };
    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
      DB: {
        prepare(sql: string) {
          query = sql;
          return statement;
        },
      },
    } as unknown as Env;

    const memory = await buildTradingMemory(env, current, 10_100);
    expect(query).toContain('o.finalized_at <= ?');
    expect(bound.slice(0, 2)).toEqual([10_000, 10_000]);
    expect(memory.status).toBe('SPARSE');
    expect(memory.analogs).toHaveLength(1);
    expect(memory.analogs[0]?.similarity ?? 0).toBeGreaterThan(0.8);
    expect(memory.outcomeSummary['15m'].medianReturnBps).toBe(8);
  });

  it('escalates reasoning depth for event risk without creating a direction', () => {
    const memory: TradingMemoryContext = {
      version: 'memory-v1',
      status: 'NO_MATCH',
      generatedAt: 1_000,
      candidateCount: 0,
      comparableCount: 0,
      analogs: [],
      outcomeSummary: {
        '5m': {
          sampleCount: 0,
          medianReturnBps: null,
          positiveReturnCount: 0,
          negativeReturnCount: 0,
        },
        '15m': {
          sampleCount: 0,
          medianReturnBps: null,
          positiveReturnCount: 0,
          negativeReturnCount: 0,
        },
        '30m': {
          sampleCount: 0,
          medianReturnBps: null,
          positiveReturnCount: 0,
          negativeReturnCount: 0,
        },
        '60m': {
          sampleCount: 0,
          medianReturnBps: null,
          positiveReturnCount: 0,
          negativeReturnCount: 0,
        },
      },
      policy: 'evidence only',
    };
    const policy = buildAdaptiveReasoningPolicy({
      snapshot: {
        decisionGates: {
          quality: 'GREEN',
          criticalBlockers: [],
          degradedSources: [],
        },
        riskContext: {
          highRiskNews: true,
          binanceCriticalNotice: false,
          nextMacroEvent: null,
        },
      },
      memory,
      crossMarket: fullCrossMarket(),
      selectedExternalItemCount: 2,
    });

    expect(policy.recommendedMode).toBe('DEEP');
    expect(policy.reasons).toContain('HIGH_RISK_NEWS');
    expect(policy.externalExpansionRecommended).toBe(true);
    expect(policy).not.toHaveProperty('side');
    expect(policy).not.toHaveProperty('signal');
  });

  it('derives deterministic position R and protection flags without an exit signal', async () => {
    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
    } as Env;
    const context = await buildPositionManagementContext(
      env,
      {
        decisionGates: { positionManagementAvailable: true },
        marketState: { markPrice: 101 },
        position: {
          source: 'BINANCE_READ_ONLY',
          side: 'LONG',
          quantity: 1,
          entryPrice: 100,
          markPrice: 101,
          leverage: 10,
          liquidationPrice: 90,
        },
        trading: {
          mode: 'LIVE_MANUAL',
          lifecycle: { stage: 'MANAGING' },
          activePlan: {
            id: 'plan-1',
            side: 'LONG',
            entry: 100,
            stop: 98,
            targets: [104, 106],
            leverage: 10,
          },
          activePaperTrade: null,
          activeLiveTrade: null,
          liveManual: {
            position: {
              side: 'LONG',
              quantity: 1,
              entryPrice: 100,
              markPrice: 101,
              leverage: 10,
              liquidationPrice: 90,
            },
            protectiveCoverage: {
              stopLossCoverageRatio: 0.5,
              takeProfitCoverageRatio: 1,
              hasFullStopCoverage: false,
              hasFullTakeProfitCoverage: true,
            },
            planMatchesPosition: true,
          },
        },
      },
      60_000,
    );

    expect(context.status).toBe('ACTIVE');
    expect(context.priceR.unrealizedR).toBeCloseTo(0.5, 8);
    expect(context.priceR.distanceToStopR).toBeCloseTo(1.5, 8);
    expect(context.flags).toContain('STOP_COVERAGE_GAP');
    expect(context).not.toHaveProperty('decision');
    expect(context).not.toHaveProperty('action');
  });
});
