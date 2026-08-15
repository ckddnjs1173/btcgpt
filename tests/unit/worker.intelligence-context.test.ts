import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../worker/src/index';
import {
  buildCrossMarketContext,
  getCrossMarketContext,
} from '../../worker/src/phase17-cross-market';
import { buildContextPack } from '../../worker/src/phase20-context-router';

function venue(
  venueName: 'BINANCE_USDM' | 'COINBASE_SPOT',
  symbol: string,
  lastPrice: number,
  return24hPercent: number,
) {
  return {
    venue: venueName,
    symbol,
    lastPrice,
    return24hPercent,
    volume24h: 100,
    quoteVolume24h: venueName === 'BINANCE_USDM' ? 1_000_000 : null,
    observedAt: 1_000,
  } as const;
}

describe('phase 17-20 intelligence batch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds direction-neutral cross-market relative metrics', () => {
    const context = buildCrossMarketContext({
      generatedAt: 1_000,
      binance: {
        BTC: venue('BINANCE_USDM', 'BTCUSDT', 100, 2),
        ETH: venue('BINANCE_USDM', 'ETHUSDT', 50, 4),
        SOL: venue('BINANCE_USDM', 'SOLUSDT', 20, -1),
      },
      coinbase: {
        BTC: venue('COINBASE_SPOT', 'BTC-USD', 100.1, 1.5),
        ETH: venue('COINBASE_SPOT', 'ETH-USD', 50.2, 3),
        SOL: venue('COINBASE_SPOT', 'SOL-USD', 19.9, -2),
      },
    });

    expect(context.completeness).toBe(1);
    expect(context.assets.BTC.crossVenueSpreadBps).toBeCloseTo(10, 8);
    expect(context.relativePerformance24h.ethMinusBtcPercentPoints).toBe(2);
    expect(context.relativePerformance24h.solMinusBtcPercentPoints).toBe(-3);
    expect(context).not.toHaveProperty('signal');
    expect(context).not.toHaveProperty('side');
  });

  it('collects Binance futures and Coinbase spot without credentials', async () => {
    const responses: Record<string, unknown> = {
      BTCUSDT: {
        lastPrice: '100',
        priceChangePercent: '2',
        volume: '10',
        quoteVolume: '1000',
      },
      ETHUSDT: {
        lastPrice: '50',
        priceChangePercent: '4',
        volume: '20',
        quoteVolume: '1000',
      },
      SOLUSDT: {
        lastPrice: '20',
        priceChangePercent: '-1',
        volume: '30',
        quoteVolume: '600',
      },
      'BTC-USD': { open: '99', last: '100.1', volume: '10' },
      'ETH-USD': { open: '49', last: '50.2', volume: '20' },
      'SOL-USD': { open: '20.3', last: '19.9', volume: '30' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const key =
          Object.keys(responses).find((candidate) => url.includes(candidate)) ??
          '';
        return Promise.resolve(
          new Response(JSON.stringify(responses[key]), {
            status: key ? 200 : 404,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );

    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
    } as Env;
    const context = await getCrossMarketContext(env, 2_000);
    expect(context.completeness).toBe(1);
    expect(context.sources.binanceUsdm.status).toBe('NORMAL');
    expect(context.sources.coinbaseSpot.status).toBe('NORMAL');
    expect(context.assets.ETH.coinbaseSpot?.lastPrice).toBe(50.2);
  });

  it('routes compact objective context without future labels or local direction scores', async () => {
    const crossMarket = buildCrossMarketContext({
      generatedAt: 2_000,
      binance: {
        BTC: venue('BINANCE_USDM', 'BTCUSDT', 100, 2),
      },
      coinbase: {
        BTC: venue('COINBASE_SPOT', 'BTC-USD', 100.1, 1.5),
      },
    });
    const snapshot = {
      snapshotId: 'snapshot-a',
      generatedAt: 1_900,
      decisionGates: {
        marketAnalysisAvailable: true,
        entryAllowed: true,
        positionManagementAvailable: true,
        quality: 'GREEN',
        criticalBlockers: [],
        degradedSources: [],
      },
      marketState: {
        markPrice: 100,
        spreadBps: 1,
        fundingRate: 0.0001,
      },
      orderFlow: {
        '1m': { delta: 5, buyRatio: 0.55 },
        '5m': { delta: 10, buyRatio: 0.6 },
        '15m': { delta: -2, buyRatio: 0.49 },
        orderBookImbalance20: 0.1,
      },
      openInterest: { current: 1_000, changes: { '5m': 1.2 } },
      sentiment: {},
      liquidations: {},
      timeframes: {},
      scalpContext: {},
      position: { side: 'FLAT' },
      costSettings: {},
      riskContext: { status: 'NORMAL', highRiskNews: false },
    };
    const env = {
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
    } as Env;
    const pack = await buildContextPack(env, snapshot, crossMarket, 2_000);

    expect(pack.version).toBe('context-v1');
    expect(pack.snapshotId).toBe('snapshot-a');
    expect(pack.objectiveOnly).toBe(true);
    expect(pack.completeness.crossMarket).toBeGreaterThan(0);
    expect(JSON.stringify(pack)).not.toContain('futurePath');
    expect(JSON.stringify(pack)).not.toContain('bullishScore');
    expect(JSON.stringify(pack)).not.toContain('bearishScore');
  });
});
