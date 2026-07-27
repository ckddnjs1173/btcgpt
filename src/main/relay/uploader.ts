import { logger } from '../logging/logger';
import type { MarketCache } from '../market/cache';
import { generateSnapshot } from '../market/snapshot';
import type { RelayStatus } from '../../shared/contracts';

export interface RelayConfiguration {
  baseUrl: string;
  uploadKey: string;
}

export class RelayUploader {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private status: RelayStatus;

  constructor(
    private readonly cache: MarketCache,
    private readonly configuration: RelayConfiguration,
  ) {
    this.status = {
      configured: true,
      baseUrl: configuration.baseUrl,
      connected: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      error: null,
    };
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    void this.upload();
    this.timer = setInterval(() => void this.upload(), 5_000);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): RelayStatus {
    return { ...this.status };
  }

  async testConnection(): Promise<void> {
    const response = await fetch(
      new URL('/health', this.configuration.baseUrl),
      { signal: AbortSignal.timeout(4_000) },
    );
    if (!response.ok)
      throw new Error(`Relay health returned HTTP ${response.status}`);
  }

  private async upload(attempt = 0): Promise<void> {
    if (this.stopping) return;
    this.status.lastAttemptAt = Date.now();
    let snapshotId: string | null = null;
    try {
      const snapshot = generateSnapshot(this.cache);
      snapshotId = snapshot.snapshotId;
      const payload = JSON.stringify(snapshot);
      if (new TextEncoder().encode(payload).byteLength > 90_000)
        throw new Error('Relay payload exceeds 90,000 bytes');
      const response = await fetch(
        new URL('/v1/snapshot/latest', this.configuration.baseUrl),
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${this.configuration.uploadKey}`,
            'content-type': 'application/json',
          },
          body: payload,
          signal: AbortSignal.timeout(4_000),
        },
      );
      if (!response.ok)
        throw new Error(`Relay returned HTTP ${response.status}`);
      this.status = {
        ...this.status,
        connected: true,
        lastSuccessAt: Date.now(),
        consecutiveFailures: 0,
        error: null,
      };
    } catch (error) {
      this.status = {
        ...this.status,
        connected: false,
        consecutiveFailures: this.status.consecutiveFailures + 1,
        error: error instanceof Error ? error.message : 'Relay upload failed',
      };
      if (attempt < 2 && !this.stopping) {
        setTimeout(() => void this.upload(attempt + 1), 500 * 2 ** attempt);
      } else {
        logger.warn({ error, snapshotId }, 'Relay upload failed');
      }
    }
  }
}
