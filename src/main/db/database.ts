import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { DatabaseCheck } from '../../shared/contracts';

const SCHEMA_VERSION = 1;

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
