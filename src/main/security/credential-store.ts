import { safeStorage } from 'electron';

import type { AccountCredentials } from '../binance/account/rest';
import type { AppDatabase } from '../db/database';

const STORAGE_KEY = 'binance_read_only_credentials';

export class CredentialStore {
  constructor(private readonly database: AppDatabase) {}

  save(credentials: AccountCredentials): void {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('OS credential encryption is unavailable');
    const encrypted = safeStorage.encryptString(JSON.stringify(credentials));
    this.database.writeSetting(STORAGE_KEY, encrypted.toString('base64'));
  }

  load(): AccountCredentials | null {
    const encoded = this.database.readSetting(STORAGE_KEY);
    if (!encoded) return null;
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('OS credential encryption is unavailable');
    return JSON.parse(
      safeStorage.decryptString(Buffer.from(encoded, 'base64')),
    ) as AccountCredentials;
  }

  clear(): void {
    this.database.deleteSetting(STORAGE_KEY);
  }

  hasCredentials(): boolean {
    return this.database.readSetting(STORAGE_KEY) !== null;
  }
}
