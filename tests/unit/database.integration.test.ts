import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AppDatabase } from '../../src/main/db/database';

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const target of temporaryPaths.splice(0))
    fs.rmSync(target, { recursive: true, force: true });
});

describe('SQLite migrations and restart recovery', () => {
  it('does not invent fee or slippage defaults', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'btcgpt-db-'));
    temporaryPaths.push(userData);
    const database = new AppDatabase(userData);
    expect(database.readUserSettings()).toMatchObject({
      makerFeeRate: null,
      takerFeeRate: null,
      entrySlippageBps: null,
      exitSlippageBps: null,
    });
    database.close();
  });

  it('persists closed candles and validated settings across reopen', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'btcgpt-db-'));
    temporaryPaths.push(userData);
    let database = new AppDatabase(userData);
    database.upsertClosedCandle({
      symbol: 'BTCUSDT',
      timeframe: '5m',
      openTime: 1_700_000_000_000,
      closeTime: 1_700_000_299_999,
      open: 60_000,
      high: 60_100,
      low: 59_900,
      close: 60_050,
      volume: 10,
      quoteVolume: 600_000,
      tradeCount: 100,
      takerBuyBaseVolume: 6,
      takerBuyQuoteVolume: 360_000,
      isClosed: true,
      receivedAt: 1_700_000_300_000,
    });
    database.saveUserSettings({
      ...database.readUserSettings(),
      makerFeeRate: 0.0002,
      takerFeeRate: 0.0005,
      maxLossUsdt: 50,
    });
    database.close();

    database = new AppDatabase(userData);
    expect(database.readClosedCandles('5m')).toHaveLength(1);
    expect(database.readUserSettings().maxLossUsdt).toBe(50);
    expect(database.readUserSettings().minimumNetMarginRoiPercent).toBe(2);
    database.close();
  });

  it('never persists an in-progress candle', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'btcgpt-db-'));
    temporaryPaths.push(userData);
    const database = new AppDatabase(userData);
    database.upsertClosedCandle({
      symbol: 'BTCUSDT',
      timeframe: '5m',
      openTime: 1,
      closeTime: 2,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      quoteVolume: 1,
      tradeCount: 1,
      takerBuyBaseVolume: 1,
      takerBuyQuoteVolume: 1,
      isClosed: false,
      receivedAt: 1,
    });
    expect(database.readClosedCandles('5m')).toHaveLength(0);
    database.close();
  });
});
