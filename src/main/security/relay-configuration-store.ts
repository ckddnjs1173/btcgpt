import { safeStorage } from 'electron';

import type { AppDatabase } from '../db/database';

const URL_KEY = 'relay_url';
const SECRET_KEY = 'relay_upload_key';

export interface StoredRelayConfiguration {
  baseUrl: string;
  uploadKey: string;
}

export class RelayConfigurationStore {
  constructor(private readonly database: AppDatabase) {}

  save(configuration: StoredRelayConfiguration): void {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('OS credential encryption is unavailable');
    this.database.writeSetting(URL_KEY, configuration.baseUrl);
    this.database.writeSetting(
      SECRET_KEY,
      safeStorage.encryptString(configuration.uploadKey).toString('base64'),
    );
  }

  load(): StoredRelayConfiguration | null {
    const baseUrl = this.database.readSetting(URL_KEY);
    const encrypted = this.database.readSetting(SECRET_KEY);
    if (!baseUrl || !encrypted) return null;
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('OS credential encryption is unavailable');
    return {
      baseUrl,
      uploadKey: safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
    };
  }

  clear(): void {
    this.database.deleteSetting(URL_KEY);
    this.database.deleteSetting(SECRET_KEY);
  }
}
