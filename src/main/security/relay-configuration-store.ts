import { safeStorage } from 'electron';

import type { AppDatabase } from '../db/database';
import { logger } from '../logging/logger';
import { relayConfigurationSchema } from '../../shared/schemas';

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
    const encrypted = safeStorage
      .encryptString(configuration.uploadKey)
      .toString('base64');
    this.database.writeSetting(URL_KEY, configuration.baseUrl);
    this.database.writeSetting(SECRET_KEY, encrypted);
  }

  load(): StoredRelayConfiguration | null {
    const baseUrl = this.database.readSetting(URL_KEY);
    const encrypted = this.database.readSetting(SECRET_KEY);
    if (!baseUrl && !encrypted) return null;
    try {
      if (!baseUrl || !encrypted)
        throw new Error('Stored relay configuration is incomplete');
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('OS credential encryption is unavailable');
      return relayConfigurationSchema.parse({
        baseUrl,
        uploadKey: safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
      });
    } catch {
      this.clear();
      logger.warn(
        'Stored relay configuration could not be recovered and was removed',
      );
      return null;
    }
  }

  clear(): void {
    this.database.deleteSetting(URL_KEY);
    this.database.deleteSetting(SECRET_KEY);
  }
}
