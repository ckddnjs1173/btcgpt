import { describe, expect, it } from 'vitest';

import { StreamTelemetry } from '../../src/main/market/stream-telemetry';

describe('StreamTelemetry', () => {
  it('tracks message age distribution and operational counters', () => {
    const telemetry = new StreamTelemetry(1_000);

    telemetry.recordMessage(1_100, 1_000);
    telemetry.recordMessage(2_500, 1_000);
    telemetry.recordParseError();
    telemetry.recordSequenceGap();
    telemetry.recordDroppedEvent(2);
    telemetry.recordReconnect();

    const snapshot = telemetry.snapshot();
    expect(snapshot).toMatchObject({
      messagesReceived: 2,
      parseErrors: 1,
      sequenceGaps: 1,
      staleMessages: 1,
      droppedEvents: 2,
      reconnectCount: 1,
      lastMessageAt: 2_500,
      lastEventAt: 1_000,
    });
    expect(snapshot.eventAgeMs.sampleCount).toBe(2);
    expect(snapshot.eventAgeMs.averageMs).toBe(800);
    expect(snapshot.eventAgeMs.p95Ms).toBeCloseTo(1_430);
    expect(snapshot.eventAgeMs.p99Ms).toBeCloseTo(1_486);
    expect(snapshot.eventAgeMs.maxMs).toBe(1_500);
  });

  it('keeps counters even when a message has no source event timestamp', () => {
    const telemetry = new StreamTelemetry(1_000);
    telemetry.recordMessage(1_000, null);

    expect(telemetry.snapshot()).toMatchObject({
      messagesReceived: 1,
      lastMessageAt: 1_000,
      lastEventAt: null,
      eventAgeMs: {
        sampleCount: 0,
        averageMs: null,
        p95Ms: null,
        p99Ms: null,
        maxMs: null,
      },
    });
  });

  it('rejects invalid thresholds and dropped-event counts', () => {
    expect(() => new StreamTelemetry(-1)).toThrow(
      'STALE_MESSAGE_THRESHOLD_INVALID',
    );
    const telemetry = new StreamTelemetry(1_000);
    expect(() => telemetry.recordDroppedEvent(0)).toThrow(
      'DROPPED_EVENT_COUNT_INVALID',
    );
  });
});
