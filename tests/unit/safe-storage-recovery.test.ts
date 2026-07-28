import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString()),
}));

vi.mock('electron', () => ({ safeStorage: safeStorageMock }));

import type { AppDatabase } from '../../src/main/db/database';
import { CredentialStore } from '../../src/main/security/credential-store';
import { RelayConfigurationStore } from '../../src/main/security/relay-configuration-store';

function databaseWith(values: Record<string, string>): {
  database: AppDatabase;
  deleteSetting: ReturnType<typeof vi.fn>;
} {
  const settings = new Map(Object.entries(values));
  const deleteSetting = vi.fn((key: string) => {
    settings.delete(key);
  });
  const database = {
    readSetting: vi.fn((key: string) => settings.get(key) ?? null),
    writeSetting: vi.fn((key: string, value: string) => {
      settings.set(key, value);
    }),
    deleteSetting,
  } as unknown as AppDatabase;
  return { database, deleteSetting };
}

describe('safeStorage recovery', () => {
  beforeEach(() => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.decryptString.mockImplementation((value: Buffer) =>
      value.toString(),
    );
  });

  it('removes unreadable Binance credentials and falls back to disconnected', () => {
    const { database, deleteSetting } = databaseWith({
      binance_read_only_credentials: 'corrupt',
    });
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('decrypt failed');
    });

    const store = new CredentialStore(database);
    expect(store.load()).toBeNull();
    expect(deleteSetting).toHaveBeenCalledWith('binance_read_only_credentials');
  });

  it('removes an incomplete relay pair instead of crashing startup', () => {
    const { database, deleteSetting } = databaseWith({
      relay_url: 'https://relay.example.workers.dev',
    });

    const store = new RelayConfigurationStore(database);
    expect(store.load()).toBeNull();
    expect(deleteSetting).toHaveBeenCalledWith('relay_url');
    expect(deleteSetting).toHaveBeenCalledWith('relay_upload_key');
  });
});
