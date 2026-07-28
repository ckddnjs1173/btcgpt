import { logger } from '../logging/logger';
import type { MarketCache } from '../market/cache';
import { generateSnapshot, type SnapshotOptions } from '../market/snapshot';
import type { RelayStatus } from '../../shared/contracts';

export interface RelayConfiguration {
  baseUrl: string;
  uploadKey: string;
}

export class RelayUploader {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private uploading = false;
  private pendingUpload = false;
  private status: RelayStatus;

  constructor(
    private readonly cache: MarketCache,
    private readonly configuration: RelayConfiguration,
    private readonly getSnapshotOptions: () => SnapshotOptions = () => ({}),
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
    this.requestUpload();
    this.timer = setInterval(() => this.requestUpload(), 5_000);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pendingUpload = false;
  }

  getStatus(): RelayStatus {
    return { ...this.status };
  }

  async testConnection(): Promise<void> {
    const response = await fetch(
      new URL('/v1/uploader/status', this.configuration.baseUrl),
      {
        headers: {
          authorization: `Bearer ${this.configuration.uploadKey}`,
        },
        signal: AbortSignal.timeout(4_000),
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? 'Relay upload key was rejected'
          : `Relay readiness returned HTTP ${response.status}`,
      );
  }

  private requestUpload(): void {
    if (this.stopping) return;
    if (this.uploading) {
      this.pendingUpload = true;
      return;
    }
    void this.runUploadQueue();
  }

  private async runUploadQueue(): Promise<void> {
    this.uploading = true;
    do {
      this.pendingUpload = false;
      await this.uploadSnapshot();
    } while (this.pendingUpload && !this.stopping);
    this.uploading = false;
  }

  private async uploadSnapshot(): Promise<void> {
    if (this.stopping) return;
    this.status.lastAttemptAt = Date.now();
    let snapshotId: string | null = null;
    try {
      const snapshot = generateSnapshot(this.cache, this.getSnapshotOptions());
      snapshotId = snapshot.snapshotId;
      const payload = JSON.stringify(snapshot);
      if (new TextEncoder().encode(payload).byteLength > 90_000)
        throw new Error('Relay payload exceeds 90,000 bytes');
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3 && !this.stopping; attempt += 1) {
        try {
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
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 2 && !this.stopping)
            await new Promise((resolve) =>
              setTimeout(resolve, 500 * 2 ** attempt),
            );
        }
      }
      if (lastError instanceof Error) throw lastError;
      if (lastError) throw new Error('Relay upload failed');
      if (this.stopping) return;
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
      logger.warn({ error, snapshotId }, 'Relay upload failed');
    }
  }
}
