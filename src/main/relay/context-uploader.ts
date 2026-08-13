import type { ExternalContextService } from '../external/service';
import { logger } from '../logging/logger';

const UPLOAD_INTERVAL_MS = 5 * 60_000;
const MAX_BODY_BYTES = 90_000;

export class ContextUploader {
  private timer: NodeJS.Timeout | null = null;
  private lastDigest = '';

  constructor(
    private readonly service: ExternalContextService,
    private readonly configuration: { baseUrl: string; uploadKey: string },
  ) {}

  start(): void {
    if (this.timer) return;
    void this.upload();
    this.timer = setInterval(() => void this.upload(), UPLOAD_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async upload(): Promise<void> {
    try {
      const snapshots = ['INTRADAY', 'SWING', 'MACRO'] as const;
      const generatedAt = Date.now();
      const payloads = snapshots.map((horizon) => {
        const snapshot = this.service.getSnapshot(horizon);
        let raw = JSON.stringify({
          schemaVersion: 2,
          generatedAt,
          snapshot,
        });
        while (
          new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES &&
          snapshot.items.length > 1
        ) {
          snapshot.items.pop();
          raw = JSON.stringify({ schemaVersion: 2, generatedAt, snapshot });
        }
        return { horizon, raw };
      });
      if (
        payloads.some(
          ({ raw }) =>
            new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES,
        )
      )
        throw new Error('EXTERNAL_CONTEXT_PAYLOAD_TOO_LARGE');
      const digest = payloads
        .map(({ raw }) => raw.replace(/"generatedAt":\d+/g, '"generatedAt":0'))
        .join('|');
      if (digest === this.lastDigest) return;
      for (const { horizon, raw } of payloads) {
        const response = await fetch(
          `${this.configuration.baseUrl}/v1/context/latest?horizon=${horizon}`,
          {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${this.configuration.uploadKey}`,
              'content-type': 'application/json',
            },
            body: raw,
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!response.ok)
          throw new Error(`CONTEXT_UPLOAD_${horizon}_HTTP_${response.status}`);
      }
      this.lastDigest = digest;
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : 'UPLOAD_FAILED' },
        'External context upload failed',
      );
    }
  }
}
