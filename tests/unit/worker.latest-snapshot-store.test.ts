import { describe, expect, it } from 'vitest';

import { loadLatestSnapshotRow } from '../../worker/src/latest-snapshot-store';
import type { Env } from '../../worker/src/index';

describe('latest snapshot storage contract', () => {
  it('reads the canonical latest_snapshot table used by migration 0001', async () => {
    let preparedSql = '';
    const env = {
      DB: {
        prepare(sql: string) {
          preparedSql = sql;
          return {
            first<T>() {
              return Promise.resolve({
                raw: '{}',
                generatedAt: 100,
                receivedAt: 110,
              } as T);
            },
          };
        },
      },
    } as unknown as Env;

    const row = await loadLatestSnapshotRow(env);

    expect(row?.generatedAt).toBe(100);
    expect(preparedSql).toContain('FROM latest_snapshot WHERE id = 1');
    expect(preparedSql).not.toContain('snapshot_latest');
  });

  it('fails closed when D1 is unavailable', async () => {
    await expect(
      loadLatestSnapshotRow({ DB: undefined } as unknown as Env),
    ).rejects.toThrow('DB_UNAVAILABLE');
  });
});
