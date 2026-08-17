import { createHash } from 'node:crypto';

import type {
  MarketSnapshot,
  RelayConfigurationInput,
  RelayStatus,
} from '../../shared/contracts';
import type { LocalMarketIntelligence } from '../../shared/decision-context';
import { logger } from '../logging/logger';
import {
  createCompactRelaySnapshot,
  RELAY_SNAPSHOT_MAX_BYTES,
} from '../market/compact-snapshot';
import type { MarketCache } from '../market/cache';
import { generateSnapshot, type SnapshotOptions } from '../market/snapshot';

export const RELAY_UPLOAD_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 4_500;

type MarketIntelligenceProvider = (
  snapshot: MarketSnapshot,
) => LocalMarketIntelligence | null;

function safeBaseUrl(input: string): string {
  const parsed = new URL(input);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('Relay URL must use http or https');
  return parsed.toString().replace(/\/$/, '');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return 'Unknown relay error';
}

export class RelayUploader {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inFlight = false;
  private readonly baseUrl: string;
  private readonly uploadKey: string;
  private readonly getSnapshotOptions: () => SnapshotOptions;
  private readonly getMarketIntelligence: MarketIntelligenceProvider;
  private status: RelayStatus;

  constructor(
    private readonly cache: MarketCache,
    configuration: RelayConfigurationInput,
    getSnapshotOptions: () => SnapshotOptions = () => ({}),
    getMarketIntelligence: MarketIntelligenceProvider = () => null,
  ) {
    this.baseUrl = safeBaseUrl(configuration.baseUrl);
    this.uploadKey = configuration.uploadKey.trim();
    if (this.uploadKey.length < 16)
      throw new Error('Relay upload key must be at least 16 characters');
    this.getSnapshotOptions = getSnapshotOptions;
    this.getMarketIntelligence = getMarketIntelligence;
    this.status = {
      configured: true,
      baseUrl: this.baseUrl,
      connected: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      error: null,
      lastPayloadBytes: null,
      lastSnapshotGeneratedAt: null,
      lastServerReceivedAt: null,
      lastRoundTripMs: null,
      lastMarketToRelayReceiveMs: null,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.uploadOnce();
    this.timer = setInterval(() => {
      void this.uploadOnce();
    }, RELAY_UPLOAD_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): RelayStatus {
    return structuredClone(this.status);
  }

  async testConnection(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`Relay health check failed: HTTP ${response.status}`);
  }

  async uploadOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const attemptAt = Date.now();
    this.status.lastAttemptAt = attemptAt;
    try {
      const fullSnapshot = generateSnapshot(
        this.cache,
        this.getSnapshotOptions(),
      );
      const marketIntelligence = this.getMarketIntelligence(fullSnapshot);
      const compact = createCompactRelaySnapshot(
        fullSnapshot,
        marketIntelligence,
      );
      if (compact.byteLength >= RELAY_SNAPSHOT_MAX_BYTES)
        throw new Error(
          `Relay snapshot exceeds ${RELAY_SNAPSHOT_MAX_BYTES} bytes after compaction`,
        );
      this.status.lastPayloadBytes = compact.byteLength;
      const response = await fetch(`${this.baseUrl}/v1/snapshot/latest`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-upload-key': this.uploadKey,
        },
        body: compact.json,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const responseBody = await response.text();
      if (!response.ok) {
        const body = responseBody.slice(0, 240);
        throw new Error(
          `Relay upload failed: HTTP ${response.status}${body ? ` ${body}` : ''}`,
        );
      }
      let serverReceivedAt: number | null = null;
      if (responseBody) {
        try {
          const parsed = JSON.parse(responseBody) as { receivedAt?: unknown };
          if (
            typeof parsed.receivedAt === 'number' &&
            Number.isFinite(parsed.receivedAt)
          )
            serverReceivedAt = parsed.receivedAt;
        } catch {
          // A successful upload remains successful if optional timing metadata is absent.
        }
      }
      const successAt = Date.now();
      this.status.connected = true;
      this.status.lastSuccessAt = successAt;
      this.status.consecutiveFailures = 0;
      this.status.error = null;
      this.status.lastSnapshotGeneratedAt = fullSnapshot.generatedAt;
      this.status.lastServerReceivedAt = serverReceivedAt;
      this.status.lastRoundTripMs = Math.max(0, successAt - attemptAt);
      this.status.lastMarketToRelayReceiveMs =
        serverReceivedAt === null
          ? null
          : Math.max(0, serverReceivedAt - fullSnapshot.generatedAt);
    } catch (error) {
      this.status.connected = false;
      this.status.consecutiveFailures += 1;
      this.status.error = errorMessage(error);
      logger.warn(
        {
          relayHostHash: createHash('sha256')
            .update(this.baseUrl)
            .digest('hex')
            .slice(0, 12),
          consecutiveFailures: this.status.consecutiveFailures,
          errorMessage: this.status.error,
        },
        'Relay snapshot upload failed',
      );
    } finally {
      this.inFlight = false;
    }
  }
}
