import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { DatabaseCheck } from '../../shared/contracts';
import type {
  ManualPosition,
  ManualPositionInput,
} from '../../shared/contracts';
import type { Candle, Timeframe } from '../market/types';
import { manualPositionSchema } from '../../shared/schemas';
import { userSettingsSchema } from '../../shared/schemas';
import type { UserSettings } from '../../shared/contracts';

const SCHEMA_VERSION = 2;
const DEFAULT_USER_SETTINGS: UserSettings = {
  gptUrl: 'https://chatgpt.com/',
  makerFeeRate: null,
  takerFeeRate: null,
  entrySlippageBps: null,
  exitSlippageBps: null,
  maxLossUsdt: null,
  riskPercent: null,
  partialTakeProfitRatios: [0.3, 0.3, 0.4],
  minimumNetMarginRoiPercent: 2,
  autoStart: false,
};

interface DatabaseCheckRow {
  value: string;
  updated_at: number;
}

export class AppDatabase {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(userDataPath: string) {
    const databaseDirectory = path.join(userDataPath, 'database');
    mkdirSync(databaseDirectory, { recursive: true });

    this.database = new DatabaseSync(
      path.join(databaseDirectory, 'btc-futures-assistant.db'),
    );
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `);
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS phase_zero_checks (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS candles (
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        open_time INTEGER NOT NULL,
        close_time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        quote_volume REAL NOT NULL,
        trade_count INTEGER NOT NULL,
        taker_buy_base_volume REAL NOT NULL,
        taker_buy_quote_volume REAL NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (symbol, timeframe, open_time)
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS manual_position (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS market_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gpt_snapshot_meta (
        snapshot_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        generated_at INTEGER NOT NULL,
        size INTEGER NOT NULL,
        status TEXT NOT NULL,
        upload_result TEXT
      );
    `);

    this.database
      .prepare(
        `
          INSERT INTO schema_meta (key, value, updated_at)
          VALUES ('schema_version', @version, @updatedAt)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        version: String(SCHEMA_VERSION),
        updatedAt: Date.now(),
      });
  }

  upsertClosedCandle(candle: Candle): void {
    if (!candle.isClosed) return;
    this.database
      .prepare(
        `
      INSERT INTO candles (
        symbol, timeframe, open_time, close_time, open, high, low, close,
        volume, quote_volume, trade_count, taker_buy_base_volume,
        taker_buy_quote_volume, received_at
      ) VALUES (
        @symbol, @timeframe, @openTime, @closeTime, @open, @high, @low, @close,
        @volume, @quoteVolume, @tradeCount, @takerBuyBaseVolume,
        @takerBuyQuoteVolume, @receivedAt
      )
      ON CONFLICT(symbol, timeframe, open_time) DO UPDATE SET
        close_time=excluded.close_time, open=excluded.open, high=excluded.high,
        low=excluded.low, close=excluded.close, volume=excluded.volume,
        quote_volume=excluded.quote_volume, trade_count=excluded.trade_count,
        taker_buy_base_volume=excluded.taker_buy_base_volume,
        taker_buy_quote_volume=excluded.taker_buy_quote_volume,
        received_at=excluded.received_at
    `,
      )
      .run({
        symbol: candle.symbol,
        timeframe: candle.timeframe,
        openTime: candle.openTime,
        closeTime: candle.closeTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        quoteVolume: candle.quoteVolume,
        tradeCount: candle.tradeCount,
        takerBuyBaseVolume: candle.takerBuyBaseVolume,
        takerBuyQuoteVolume: candle.takerBuyQuoteVolume,
        receivedAt: candle.receivedAt,
      });
  }

  readClosedCandles(timeframe: Timeframe, limit = 500): Candle[] {
    const rows = this.database
      .prepare(
        `
      SELECT symbol, timeframe, open_time, close_time, open, high, low, close,
        volume, quote_volume, trade_count, taker_buy_base_volume,
        taker_buy_quote_volume, received_at
      FROM candles WHERE symbol = 'BTCUSDT' AND timeframe = ?
      ORDER BY open_time DESC LIMIT ?
    `,
      )
      .all(timeframe, limit) as Array<Record<string, string | number>>;
    return rows.reverse().map((row) => ({
      symbol: 'BTCUSDT',
      timeframe,
      openTime: Number(row.open_time),
      closeTime: Number(row.close_time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      quoteVolume: Number(row.quote_volume),
      tradeCount: Number(row.trade_count),
      takerBuyBaseVolume: Number(row.taker_buy_base_volume),
      takerBuyQuoteVolume: Number(row.taker_buy_quote_volume),
      receivedAt: Number(row.received_at),
      isClosed: true,
    }));
  }

  writeSetting(key: string, value: string): void {
    this.database
      .prepare(
        `
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `,
      )
      .run(key, value, Date.now());
  }

  readSetting(key: string): string | null {
    const row = this.database
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  deleteSetting(key: string): void {
    this.database.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }

  saveManualPosition(input: ManualPositionInput): ManualPosition {
    const position: ManualPosition = {
      source: 'MANUAL',
      side: input.side,
      quantity: input.quantity,
      entryPrice: input.entryPrice,
      notional: input.quantity * input.entryPrice,
      isolatedMargin: (input.quantity * input.entryPrice) / 10,
      leverage: 10,
      marginMode: 'ISOLATED',
      stopPrice: input.stopPrice ?? null,
      targetPrices: input.targetPrices ?? [],
      entryOrderType: input.entryOrderType ?? 'TAKER',
      plannedExitOrderType: input.plannedExitOrderType ?? 'TAKER',
      openedAt: input.openedAt ?? null,
      updatedAt: Date.now(),
    };
    this.database
      .prepare(
        `
      INSERT INTO manual_position (id, value, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `,
      )
      .run(JSON.stringify(position), position.updatedAt);
    return position;
  }

  readManualPosition(): ManualPosition | null {
    const row = this.database
      .prepare('SELECT value FROM manual_position WHERE id = 1')
      .get() as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = manualPositionSchema.safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  clearManualPosition(): void {
    this.database.prepare('DELETE FROM manual_position WHERE id = 1').run();
  }

  readUserSettings(): UserSettings {
    const raw = this.readSetting('user_settings');
    if (!raw) return { ...DEFAULT_USER_SETTINGS };
    try {
      const parsed = userSettingsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : { ...DEFAULT_USER_SETTINGS };
    } catch {
      return { ...DEFAULT_USER_SETTINGS };
    }
  }

  saveUserSettings(settings: UserSettings): UserSettings {
    const validated = userSettingsSchema.parse(settings);
    this.writeSetting('user_settings', JSON.stringify(validated));
    return validated;
  }

  clearLocalData(): void {
    this.database.exec(`
      BEGIN IMMEDIATE;
      DELETE FROM phase_zero_checks;
      DELETE FROM candles;
      DELETE FROM app_settings;
      DELETE FROM manual_position;
      DELETE FROM market_state;
      DELETE FROM gpt_snapshot_meta;
      COMMIT;
    `);
  }

  isReady(): boolean {
    if (this.closed) {
      return false;
    }

    const result = this.database.prepare('SELECT 1 AS healthy').get() as
      { healthy: number } | undefined;

    return result?.healthy === 1;
  }

  writePhaseZeroCheck(value: string): DatabaseCheck {
    const updatedAt = Date.now();

    this.database
      .prepare(
        `
          INSERT INTO phase_zero_checks (id, value, updated_at)
          VALUES (1, @value, @updatedAt)
          ON CONFLICT(id) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `,
      )
      .run({ value, updatedAt });

    return this.readPhaseZeroCheck();
  }

  readPhaseZeroCheck(): DatabaseCheck {
    const row = this.database
      .prepare('SELECT value, updated_at FROM phase_zero_checks WHERE id = 1')
      .get() as DatabaseCheckRow | undefined;

    const countRow = this.database
      .prepare('SELECT COUNT(*) AS count FROM phase_zero_checks')
      .get() as { count: number };

    return {
      ok: this.isReady(),
      value: row?.value ?? null,
      updatedAt: row?.updated_at ?? null,
      recordCount: countRow.count,
    };
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }
}
