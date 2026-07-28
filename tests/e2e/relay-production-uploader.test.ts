// @vitest-environment node

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MarketCache } from '../../src/main/market/cache';
import { RelayUploader } from '../../src/main/relay/uploader';
import { TIMEFRAMES } from '../../src/main/market/types';

const baseUrl = process.env.RELAY_PRODUCTION_URL;
const secretFile = process.env.RELAY_SECRET_FILE;
const enabled = Boolean(baseUrl && secretFile);

describe.skipIf(!enabled)('production relay uploader', () => {
  it('publishes the shared snapshot through the five-second uploader', async () => {
    const secrets = JSON.parse(
      fs.readFileSync(secretFile!, 'utf8').replace(/^\uFEFF/, ''),
    ) as {
      UPLOADER_WRITE_KEY: string;
      ACTION_READ_KEY: string;
    };
    expect(secrets.UPLOADER_WRITE_KEY).not.toBe(secrets.ACTION_READ_KEY);

    const cache = new MarketCache();
    const now = Date.now();
    for (const timeframe of TIMEFRAMES)
      for (let index = 0; index < 250; index += 1) {
        const openTime = now - (250 - index) * 300_000;
        cache.upsertCandle({
          symbol: 'BTCUSDT',
          timeframe,
          openTime,
          closeTime: openTime + 299_999,
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
    cache.setConnected(true);
    cache.updateState(
      {
        lastPrice: 60_050,
        markPrice: 60_050,
        indexPrice: 60_040,
        fundingRate: 0.0001,
        nextFundingTime: now + 3_600_000,
        bidPrice: 60_049,
        askPrice: 60_051,
      },
      now,
    );
    cache.updateState({ openInterest: 1_000 }, now, 'openInterest', now);
    cache.updateState({}, now, 'bookTicker', now);
    cache.updateDepth([[60_049, 2]], [[60_051, 2]], now, now);
    cache.addTrade({
      id: 1,
      eventTime: now,
      receivedAt: now,
      price: 60_050,
      quantity: 0.1,
      buyerIsMaker: false,
    });
    cache.setProductFilters({
      tickSize: 0.1,
      stepSize: 0.001,
      minQuantity: 0.001,
      minNotional: 5,
      updatedAt: now,
    });

    const uploader = new RelayUploader(cache, {
      baseUrl: baseUrl!,
      uploadKey: secrets.UPLOADER_WRITE_KEY,
    });
    uploader.start();
    try {
      const deadline = Date.now() + 12_000;
      while (
        uploader.getStatus().lastSuccessAt === null &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 250));
      const status = uploader.getStatus();
      expect(status.connected).toBe(true);
      expect(status.lastSuccessAt).not.toBeNull();
      expect(status.consecutiveFailures).toBe(0);

      const response = await fetch(new URL('/v1/snapshot/latest', baseUrl), {
        headers: {
          authorization: `Bearer ${secrets.ACTION_READ_KEY}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status).toBe(200);
      const snapshot = (await response.json()) as {
        symbol: string;
        analysisGate: { analysisAllowed: boolean };
      };
      expect(snapshot.symbol).toBe('BTCUSDT');
      expect(snapshot.analysisGate.analysisAllowed).toBe(true);
    } finally {
      uploader.stop();
    }
  }, 20_000);
});
