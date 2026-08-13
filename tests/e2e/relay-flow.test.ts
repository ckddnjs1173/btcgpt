import { describe, expect, it } from 'vitest';

import { createCompactRelaySnapshot } from '../../src/main/market/compact-snapshot';
import { MarketCache } from '../../src/main/market/cache';
import { generateSnapshot } from '../../src/main/market/snapshot';
import { TIMEFRAMES } from '../../src/main/market/types';
import { handler, type Env } from '../../worker/src/index';

type Row = { raw: string; generatedAt: number; receivedAt: number };

class RelayD1 {
  private snapshot: Row | null = null;
  private trading: Row | null = null;

  prepare(query: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...nextValues: unknown[]) => {
        values = nextValues;
        return statement;
      },
      run: () => {
        const [raw, generatedAt, receivedAt] = values as [
          string,
          number,
          number,
        ];
        if (query.includes('INSERT INTO latest_snapshot'))
          this.snapshot = { raw, generatedAt, receivedAt };
        if (query.includes('INSERT INTO latest_trading_state'))
          this.trading = { raw, generatedAt, receivedAt };
        return Promise.resolve({ success: true });
      },
      first: <T>(): Promise<T | null> => {
        if (query.includes('FROM latest_snapshot'))
          return Promise.resolve(this.snapshot as T | null);
        if (query.includes('FROM latest_trading_state'))
          return Promise.resolve(this.trading as T | null);
        if (query.includes('FROM external_context_summary'))
          return Promise.resolve(null);
        if (query.includes('SELECT 1 AS ok'))
          return Promise.resolve({ ok: 1 } as T);
        return Promise.resolve(null);
      },
    };
    return statement;
  }
}

describe('local snapshot to Action relay flow', () => {
  it('generates, compacts, authenticates, uploads, and reads one shared snapshot', async () => {
    const cache = new MarketCache();
    const now = Date.now();
    for (const timeframe of TIMEFRAMES) {
      for (let index = 0; index < 250; index += 1) {
        cache.upsertCandle({
          symbol: 'BTCUSDT',
          timeframe,
          openTime: index,
          closeTime: index + 1,
          open: 60_000,
          high: 60_100,
          low: 59_900,
          close: 60_050,
          volume: 10,
          quoteVolume: 600_000,
          tradeCount: 20,
          takerBuyBaseVolume: 5,
          takerBuyQuoteVolume: 300_000,
          isClosed: true,
          eventTime: now,
          receivedAt: now,
        });
      }
    }
    cache.setConnected(true);
    cache.updateState(
      {
        lastPrice: 60_050,
        markPrice: 60_050,
        indexPrice: 60_040,
        bidPrice: 60_049,
        askPrice: 60_051,
      },
      now,
    );
    cache.updateState({ openInterest: 1_000 }, now, 'openInterest', now);
    cache.updateDepth([[60_049, 2]], [[60_051, 2]], now, now, {
      synchronized: true,
      lastUpdateId: 1,
      levelCount: 1,
    });
    cache.updateState({}, now, 'bookTicker', now);
    cache.setProductFilters({
      tickSize: 0.1,
      stepSize: 0.001,
      minQuantity: 0.001,
      minNotional: 5,
      updatedAt: now,
    });
    cache.addTrade({
      eventTime: now,
      receivedAt: now,
      price: 60_050,
      quantity: 0.1,
      buyerIsMaker: false,
    });

    const fullSnapshot = generateSnapshot(cache, { serverTime: now });
    const compact = createCompactRelaySnapshot(fullSnapshot);
    const env: Env = {
      DB: new RelayD1(),
      UPLOADER_WRITE_KEY: 'upload',
      ACTION_READ_KEY: 'read',
    };
    const upload = await handler(
      new Request('https://relay/v1/snapshot/latest', {
        method: 'PUT',
        headers: { authorization: 'Bearer upload' },
        body: compact.json,
      }),
      env,
    );
    expect(upload.status).toBe(200);

    const read = await handler(
      new Request('https://relay/v1/snapshot/latest', {
        headers: { authorization: 'Bearer read' },
      }),
      env,
    );
    expect(read.status).toBe(200);
    const returned = (await read.json()) as { snapshotId: string };
    expect(returned.snapshotId).toBe(fullSnapshot.snapshotId);
  });
});
