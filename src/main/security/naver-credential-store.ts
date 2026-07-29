import { safeStorage } from 'electron';

import type { AppDatabase } from '../db/database';
import { naverConfigurationSchema } from '../../shared/schemas';

const STORAGE_KEY = 'naver_news_credentials';

export class NaverCredentialStore {
  constructor(private readonly database: AppDatabase) {}

  save(credentials: { clientId: string; clientSecret: string }): void {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('OS credential encryption is unavailable');
    const validated = naverConfigurationSchema.parse(credentials);
    this.database.writeSetting(
      STORAGE_KEY,
      safeStorage
        .encryptString(JSON.stringify(validated))
        .toString('base64'),
    );
  }

  load(): { clientId: string; clientSecret: string } | null {
    const raw = this.database.readSetting(STORAGE_KEY);
    if (!raw || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return naverConfigurationSchema.parse(
        JSON.parse(safeStorage.decryptString(Buffer.from(raw, 'base64'))),
      );
    } catch {
      this.clear();
      return null;
    }
  }

  clear(): void {
    this.database.deleteSetting(STORAGE_KEY);
  }
}
