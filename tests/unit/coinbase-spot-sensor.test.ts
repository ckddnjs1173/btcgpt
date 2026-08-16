import { describe, expect, it } from 'vitest';

import { CoinbaseSpotAccumulator } from '../../src/main/market/cross-venue/coinbase-spot-accumulator';
import { CoinbaseSpotMarketService } from '../../src/main/market/cross-venue/coinbase-spot-service';

function connection(now: number) {
  return {
    now,
    connected: true,
    lastMessageAt: now,
    lastHeartbeatAt: now,
    reconnectCount: 0,
    sequenceGapCount: 0,
  };
}

describe('Coinbase spot accumulator', () => {
  it('reconciles level2 snapshot/update/delete and computes top-book facts', () => {
    const accumulator = new CoinbaseSpotAccumulator('BTC-USD');
    accumulator.applyBookSnapshot(
      [
        { side: 'bid', price: 100, quantity: 2 },
        { side: 'bid', price: 99, quantity: 4 },
        { side: 'offer', price: 101, quantity: 3 },
        { side: 'offer', price: 102, quantity: 5 },
      ],
      1_000,
      1_010,
    );
    accumulator.ingestTicker({
      eventTime: 1_000,
      receivedAt: 1_010,
      price: 100.5,
      bestBid: 100,
      bestAsk: 101,
    });
    accumulator.applyBookUpdate(
      [
        { side: 'bid', price: 100, quantity: 0 },
        { side: 'bid', price: 100.5, quantity: 1 },
      ],
      2_000,
      2_010,
    );

    const observation = accumulator.snapshot(connection(2_010));
    expect(observation?.microstructure.bookSynchronized).toBe(true);
    expect(observation?.bidPrice).toBe(100.5);
    expect(observation?.askPrice).toBe(101);
    expect(observation?.microstructure.bidNotional20).toBeCloseTo(
      100.5 + 99 * 4,
    );
    expect(observation?.microstructure.askNotional20).toBeCloseTo(
      101 * 3 + 102 * 5,
    );
    expect(observation?.microstructure.depthImbalance20).not.toBeNull();
    expect(observation?.provenance.map((row) => row.source)).toContain(
      'COINBASE_ADVANCED_LEVEL2',
    );
  });

  it('inverts Coinbase maker side before computing aggressive taker delta', () => {
    const accumulator = new CoinbaseSpotAccumulator('ETH-USD');
    accumulator.ingestTrade({
      eventTime: 10_000,
      receivedAt: 10_010,
      price: 100,
      size: 2,
      makerSide: 'SELL',
    });
    accumulator.ingestTrade({
      eventTime: 11_000,
      receivedAt: 11_010,
      price: 100,
      size: 1,
      makerSide: 'BUY',
    });

    const observation = accumulator.snapshot(connection(12_000));
    expect(observation?.flow['15s'].aggressiveBuyNotional).toBe(200);
    expect(observation?.flow['15s'].aggressiveSellNotional).toBe(100);
    expect(observation?.flow['15s'].normalizedTakerDelta).toBeCloseTo(1 / 3);
    expect(observation?.flow['15s'].aggressiveBuyRatio).toBeCloseTo(2 / 3);
  });

  it('computes sampled short returns without creating a directional label', () => {
    const accumulator = new CoinbaseSpotAccumulator('SOL-USD');
    accumulator.ingestTicker({
      eventTime: 1_000,
      receivedAt: 1_000,
      price: 100,
      bestBid: 99.9,
      bestAsk: 100.1,
    });
    accumulator.ingestTicker({
      eventTime: 62_000,
      receivedAt: 62_000,
      price: 101,
      bestBid: 100.9,
      bestAsk: 101.1,
    });
    const observation = accumulator.snapshot(connection(62_000));
    expect(observation?.returnsBps['1m']).toBeCloseTo(100);
    expect(observation).not.toHaveProperty('signal');
    expect(observation).not.toHaveProperty('bullishScore');
  });
});

describe('Coinbase spot message parser', () => {
  it('applies recorded ticker/trade/level2 messages and ignores unknown channels', () => {
    const service = new CoinbaseSpotMarketService({ now: () => 10_000 });
    service.ingestRecordedMessage(
      'BTC-USD',
      JSON.stringify({
        channel: 'ticker',
        timestamp: '1970-01-01T00:00:09.000Z',
        sequence_num: 1,
        events: [
          {
            type: 'update',
            tickers: [
              {
                product_id: 'BTC-USD',
                price: '100',
                best_bid: '99.5',
                best_ask: '100.5',
              },
            ],
          },
        ],
      }),
      9_010,
    );
    service.ingestRecordedMessage(
      'BTC-USD',
      JSON.stringify({
        channel: 'market_trades',
        timestamp: '1970-01-01T00:00:09.500Z',
        sequence_num: 1,
        events: [
          {
            type: 'update',
            trades: [
              {
                trade_id: '1',
                product_id: 'BTC-USD',
                price: '100',
                size: '1',
                side: 'SELL',
                time: '1970-01-01T00:00:09.500Z',
              },
            ],
          },
        ],
      }),
      9_510,
    );
    service.ingestRecordedMessage(
      'BTC-USD',
      JSON.stringify({
        channel: 'l2_data',
        timestamp: '1970-01-01T00:00:09.600Z',
        sequence_num: 7,
        events: [
          {
            type: 'snapshot',
            product_id: 'BTC-USD',
            updates: [
              {
                side: 'bid',
                event_time: '1970-01-01T00:00:09.600Z',
                price_level: '99.5',
                new_quantity: '2',
              },
              {
                side: 'offer',
                event_time: '1970-01-01T00:00:09.600Z',
                price_level: '100.5',
                new_quantity: '3',
              },
            ],
          },
        ],
      }),
      9_610,
    );
    service.ingestRecordedMessage(
      'BTC-USD',
      JSON.stringify({ channel: 'future_new_channel', events: [] }),
      9_700,
    );

    const observation = service.getObservations(10_000)['BTC-USD'];
    expect(observation?.lastPrice).toBe(100);
    expect(observation?.flow['15s'].aggressiveBuyNotional).toBe(100);
    expect(observation?.microstructure.bookSynchronized).toBe(true);
  });

  it('drops synchronized level2 state on a sequence gap', () => {
    const service = new CoinbaseSpotMarketService({ now: () => 10_000 });
    service.ingestRecordedMessage(
      'BTC-USD',
      JSON.stringify({
        channel: 'l2_data',
        sequence_num: 10,
        events: [
          {
            type: 'snapshot',
            product_id: 'BTC-USD',
            updates: [
              {
                side: 'bid',
                event_time: '1970-01-01T00:00:09.000Z',
                price_level: '99',
                new_quantity: '1',
              },
              {
                side: 'offer',
                event_time: '1970-01-01T00:00:09.000Z',
                price_level: '101',
                new_quantity: '1',
              },
            ],
          },
        ],
      }),
      9_000,
    );
    expect(
      service.getObservations(9_100)['BTC-USD']?.microstructure
        .bookSynchronized,
    ).toBe(true);

    service.ingestRecordedMessage(
      'BTC-USD',
      JSON.stringify({
        channel: 'l2_data',
        sequence_num: 12,
        events: [
          {
            type: 'update',
            product_id: 'BTC-USD',
            updates: [],
          },
        ],
      }),
      9_200,
    );
    expect(
      service.getObservations(9_300)['BTC-USD']?.microstructure
        .bookSynchronized,
    ).toBe(false);
    expect(service.getStatus()['BTC-USD'].sequenceGapCount).toBe(1);
  });
});
