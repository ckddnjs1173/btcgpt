import { logger } from '../logging/logger';
import type { MarketCache } from '../market/cache';
import { generateSnapshot, type SnapshotOptions } from '../market/snapshot';
import {
  createCompactRelaySnapshot,
  RELAY_SNAPSHOT_MAX_BYTES,
} from '../market/compact-snapshot';
import type { RelayStatus } from '../../shared/contracts';

export interface RelayConfiguration {
  baseUrl: string;
  uploadKey: string;
}

class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly workerErrorCode: string,
  ) {
    super(`Relay returned HTTP ${status}: ${workerErrorCode}`);
    this.name = 'RelayHttpError';
  }
}

async function readWorkerErrorCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      body !== null &&
      typeof body === 'object' &&
      'error' in body &&
      typeof body.error === 'string' &&
      /^[A-Z0-9_]{1,100}$/.test(body.error)
    )
      return body.error;
  } catch {
    return 'UNPARSEABLE_ERROR_RESPONSE';
  }
  return 'INVALID_ERROR_RESPONSE';
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
      lastPayloadBytes: null,
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
    let compactByteLength: number | null = null;
    let httpStatus: number | null = null;
    let workerErrorCode: string | null = null;
    try {
      const snapshot = generateSnapshot(this.cache, this.getSnapshotOptions());
      snapshotId = snapshot.snapshotId;
      const compact = createCompactRelaySnapshot(snapshot);
      compactByteLength = compact.byteLength;
      this.status.lastPayloadBytes = compact.byteLength;
      if (compact.byteLength >= RELAY_SNAPSHOT_MAX_BYTES) {
        logger.warn(
          { snapshotId, sectionBytes: compact.sectionBytes },
          'Relay compact snapshot exceeds byte limit',
        );
        throw new Error('Relay compact snapshot exceeds byte limit');
      }
      const payload = compact.json;
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
            throw new RelayHttpError(
              response.status,
              await readWorkerErrorCode(response),
            );
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
        lastPayloadBytes: compact.byteLength,
      };
      logger.info(
        {
          snapshotId,
          compactByteLength: compact.byteLength,
          accountConnected: snapshot.account.connected,
          recentTradeCount: compact.snapshot.account.recentTrades.length,
          forbiddenOrderIdPresent:
            compact.snapshot.account.recentTrades.some((trade) =>
              Object.hasOwn(trade, 'orderId'),
            ) ||
            compact.snapshot.trading.liveManual.recentTrades.some((trade) =>
              Object.hasOwn(trade, 'orderId'),
            ),
        },
        'Relay upload succeeded',
      );
    } catch (error) {
      if (error instanceof RelayHttpError) {
        httpStatus = error.status;
        workerErrorCode = error.workerErrorCode;
      }
      const errorMessage =
        error instanceof Error ? error.message : 'Relay upload failed';
      this.status = {
        ...this.status,
        connected: false,
        consecutiveFailures: this.status.consecutiveFailures + 1,
        error: errorMessage,
      };
      logger.warn(
        {
          httpStatus,
          workerErrorCode,
          errorMessage,
          snapshotId,
          compactByteLength,
        },
        'Relay upload failed',
      );
    }
  }
}
