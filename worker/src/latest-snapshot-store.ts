import type { Env } from './index';

export interface LatestSnapshotRow {
  raw: string;
  generatedAt: number;
  receivedAt: number;
}

export async function loadLatestSnapshotRow(
  env: Env,
): Promise<LatestSnapshotRow | null> {
  if (!env.DB) throw new Error('DB_UNAVAILABLE');
  return env.DB.prepare(
    `SELECT payload AS raw, generated_at AS generatedAt,
      received_at AS receivedAt FROM latest_snapshot WHERE id = 1`,
  ).first<LatestSnapshotRow>();
}
