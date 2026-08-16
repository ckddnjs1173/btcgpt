import { describe, expect, it } from 'vitest';

import {
  LeadAssetAccumulator,
  relativeReturnBps,
} from '../../src/main/market/multicoin/lead-accumulator';
import { LeadCoreMarketService } from '../../src/main/market/multicoin/lead-service';

const NOW = 10_000_000;

function trade(
  accumulator: LeadAssetAccumulator,
  input: {
    at: number;
    price: number;
    quantity?: number;
    buyerIsMaker?: boolean;
  },
) {
  accumulator.recordTrade({
    price: input.price,
    quantity: input.quantity ?? 1,
    buyerIsMaker: input.buyerIsMaker ?? false,
    eventAt: input.at,
    receivedAt: input.at,
  });
}

describe('ETH/SOL lead-core market intelligence', () => {
  it('derives objective trade-flow, returns, depth, OI and observed liquidation facts', () => {
    const accumulator = new LeadAssetAccumulator('ETHUSDT');

    trade(accumulator, {
      at: NOW - 15_000,
      price: 2_000,
      quantity: 2,
      buyerIsMaker: false,
    });
    trade(accumulator, {
      at: NOW - 1_000,
      price: 2_010,
      quantity: 1,
      buyerIsMaker: true,
    });
    trade(accumulator, {
      at: NOW,
      price: 2_020,
      quantity: 3,
      buyerIsMaker: false,
    });

    accumulator.recordBookTicker({
      bidPrice: 2_019,
      bidQuantity: 3,
      askPrice: 2_021,
      askQuantity: 2,
      eventAt: NOW,
      receivedAt: NOW,
    });
    accumulator.recordDepth({
      bids: [
        [2_019, 3],
        [2_018, 4],
      ],
      asks: [
        [2_021, 2],
        [2_022, 5],
      ],
      eventAt: NOW,
      receivedAt: NOW,
    });
    accumulator.recordMark({
      markPrice: 2_020,
      indexPrice: 2_019.5,
      fundingRate: 0.0001,
      nextFundingTime: NOW + 60_000,
      eventAt: NOW,
      receivedAt: NOW,
    });
    accumulator.recordOpenInterest({
      openInterest: 100_000,
      observedAt: NOW - 60_000,
      receivedAt: NOW - 60_000,
    });
    accumulator.recordOpenInterest({
      openInterest: 101_000,
      observedAt: NOW,
      receivedAt: NOW,
    });
    accumulator.recordLiquidation({
      side: 'SELL',
      quantity: 2,
      price: 2_015,
      eventAt: NOW - 10_000,
      receivedAt: NOW - 10_000,
    });
    accumulator.recordLiquidation({
      side: 'BUY',
      quantity: 1,
      price: 2_025,
      eventAt: NOW - 5_000,
      receivedAt: NOW - 5_000,
    });
    accumulator.recordClosedOneMinuteCandle({
      openTime: NOW - 60_000,
      closeTime: NOW - 1,
      open: 1_995,
      high: 2_022,
      low: 1_990,
      close: 2_018,
      volume: 200,
      quoteVolume: 400_000,
      tradeCount: 500,
      takerBuyQuoteVolume: 220_000,
      closed: true,
    });

    const snapshot = accumulator.snapshot(NOW);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.market.lastPrice).toBe(2_020);
    expect(snapshot?.returnsBps['15s']).toBeCloseTo(100);
    expect(snapshot?.tradeFlow['15s'].sampleCount).toBe(3);
    expect(snapshot?.tradeFlow['15s'].normalizedDelta).not.toBeNull();
    expect(snapshot?.microstructure.depthLevels).toBe(20);
    expect(snapshot?.microstructure.bidNotional20).toBeGreaterThan(0);
    expect(snapshot?.microstructure.askNotional20).toBeGreaterThan(0);
    expect(snapshot?.openInterest.changesPercent['1m']).toBeCloseTo(1);
    expect(snapshot?.liquidations['1m'].eventCount).toBe(2);
    expect(snapshot?.liquidations['1m'].observedLongNotional).toBe(4_030);
    expect(snapshot?.liquidations['1m'].observedShortNotional).toBe(2_025);
    expect(snapshot?.liquidations['1m'].coverage).toBe('SNAPSHOT');
    expect(snapshot?.latestClosed1m?.closed).toBe(true);
    expect(
      snapshot?.provenance.some((row) => row.metricNature === 'ESTIMATED'),
    ).toBe(false);
  });

  it('clears incomplete rolling windows across websocket gaps while preserving OI history', () => {
    const accumulator = new LeadAssetAccumulator('SOLUSDT');
    trade(accumulator, { at: NOW - 15_000, price: 100 });
    trade(accumulator, { at: NOW, price: 101 });
    accumulator.recordOpenInterest({
      openInterest: 10_000,
      observedAt: NOW,
      receivedAt: NOW,
    });
    accumulator.recordBookTicker({
      bidPrice: 100.9,
      bidQuantity: 10,
      askPrice: 101.1,
      askQuantity: 8,
      eventAt: NOW,
      receivedAt: NOW,
    });

    accumulator.resetMarketStream();
    const afterMarketGap = accumulator.snapshot(NOW + 1);
    expect(afterMarketGap?.openInterest.current).toBe(10_000);
    expect(afterMarketGap?.market.lastPrice).toBeNull();
    expect(afterMarketGap?.returnsBps['15s']).toBeNull();
    expect(afterMarketGap?.tradeFlow['15s'].sampleCount).toBe(0);

    accumulator.resetPublicStream();
    expect(accumulator.snapshot(NOW + 2)).toBeNull();
  });

  it('computes BTC-relative performance without assigning direction labels', () => {
    expect(relativeReturnBps(42, 12)).toBe(30);
    expect(relativeReturnBps(null, 12)).toBeNull();
  });

  it('parses Binance combined-stream messages for both lead assets', () => {
    const service = new LeadCoreMarketService({ now: () => NOW });
    service.ingestRecordedMessage(
      JSON.stringify({
        stream: 'ethusdt@aggTrade',
        data: {
          E: NOW,
          s: 'ETHUSDT',
          p: '2020.0',
          q: '1.5',
          T: NOW,
          m: false,
        },
      }),
      NOW,
    );
    service.ingestRecordedMessage(
      JSON.stringify({
        stream: 'solusdt@bookTicker',
        data: {
          E: NOW,
          T: NOW,
          s: 'SOLUSDT',
          b: '100.0',
          B: '20',
          a: '100.1',
          A: '18',
        },
      }),
      NOW,
    );
    service.ingestRecordedMessage(
      JSON.stringify({
        stream: 'solusdt@depth20@100ms',
        data: {
          E: NOW,
          T: NOW,
          s: 'SOLUSDT',
          b: [['100.0', '20']],
          a: [['100.1', '18']],
        },
      }),
      NOW,
    );
    service.ingestRecordedMessage(
      JSON.stringify({
        stream: 'ethusdt@markPrice@1s',
        data: {
          E: NOW,
          s: 'ETHUSDT',
          p: '2019.5',
          i: '2019.4',
          r: '0.0001',
          T: NOW + 60_000,
        },
      }),
      NOW,
    );
    service.ingestRecordedMessage(
      JSON.stringify({
        stream: 'ethusdt@kline_1m',
        data: {
          E: NOW,
          s: 'ETHUSDT',
          k: {
            t: NOW - 60_000,
            T: NOW - 1,
            i: '1m',
            o: '2000',
            h: '2022',
            l: '1995',
            c: '2020',
            v: '100',
            q: '200000',
            n: 300,
            Q: '110000',
            x: true,
          },
        },
      }),
      NOW,
    );
    service.ingestRecordedMessage(
      JSON.stringify({
        stream: 'ethusdt@forceOrder',
        data: {
          E: NOW,
          o: {
            s: 'ETHUSDT',
            S: 'SELL',
            q: '2',
            ap: '2018',
            p: '2017',
            T: NOW,
          },
        },
      }),
      NOW,
    );

    const observations = service.getObservations(NOW);
    expect(observations.ETHUSDT?.market.lastPrice).toBe(2_020);
    expect(observations.ETHUSDT?.market.markPrice).toBe(2_019.5);
    expect(observations.ETHUSDT?.latestClosed1m?.close).toBe(2_020);
    expect(observations.ETHUSDT?.liquidations['1m'].eventCount).toBe(1);
    expect(observations.SOLUSDT?.market.bidPrice).toBe(100);
    expect(observations.SOLUSDT?.microstructure.depthLevels).toBe(20);

    for (const health of service.getEvidenceHealth(NOW)) {
      expect(health.requiredForEntry).toBe(false);
    }
  });

  it('rejects unsupported symbols instead of silently widening the universe', () => {
    const service = new LeadCoreMarketService({ now: () => NOW });
    expect(() =>
      service.ingestRecordedMessage(
        JSON.stringify({
          stream: 'dogeusdt@aggTrade',
          data: {
            E: NOW,
            s: 'DOGEUSDT',
            p: '0.2',
            q: '1',
            T: NOW,
            m: false,
          },
        }),
        NOW,
      ),
    ).toThrow();
  });
});
