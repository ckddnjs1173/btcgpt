import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const migrationDir = path.resolve('worker/migrations');
const names = (await readdir(migrationDir))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

if (names.length === 0) throw new Error('No D1 migrations found.');

for (const [index, name] of names.entries()) {
  const expected = String(index + 1).padStart(4, '0');
  if (!name.startsWith(`${expected}_`)) {
    throw new Error(
      `D1 migration numbering gap: expected ${expected}_..., received ${name}`,
    );
  }
}

const database = new DatabaseSync(':memory:');
try {
  database.exec('PRAGMA foreign_keys = ON;');
  for (const name of names) {
    const sql = await readFile(path.join(migrationDir, name), 'utf8');
    if (/\bCREATE\s+TRIGGER\b/i.test(sql)) {
      throw new Error(
        `${name}: CREATE TRIGGER is prohibited in D1 migrations. Keep migration SQL statement-simple and perform analytics enrichment in Worker code.`,
      );
    }
    try {
      database.exec(sql);
    } catch (error) {
      throw new Error(`${name}: migration execution failed: ${String(error)}`);
    }
  }

  const requiredTables = [
    'latest_snapshot',
    'decision_log',
    'decision_trade_lineage',
    'replay_cases',
    'replay_case_outcomes',
    'replay_experiments',
    'replay_eval_runs',
  ];
  const tableStatement = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  for (const table of requiredTables) {
    const row = tableStatement.get(table);
    if (!row)
      throw new Error(`Required D1 table missing after migrations: ${table}`);
  }

  const lineageColumns = database
    .prepare('PRAGMA table_info(decision_trade_lineage)')
    .all()
    .map((row) => String(row.name));
  for (const column of ['realized_net_r', 'mfe_r', 'mae_r', 'plan_leverage']) {
    if (!lineageColumns.includes(column)) {
      throw new Error(
        `decision_trade_lineage.${column} missing after full migration chain`,
      );
    }
  }

  console.log(
    `D1 migration validation passed: ${names.length} migrations (${names[0]} -> ${names.at(-1)}).`,
  );
} finally {
  database.close();
}
