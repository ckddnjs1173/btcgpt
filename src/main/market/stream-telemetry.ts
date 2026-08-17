export interface EventAgeDistribution {
  sampleCount: number;
  averageMs: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export interface StreamOperationalTelemetry {
  messagesReceived: number;
  parseErrors: number;
  sequenceGaps: number;
  staleMessages: number;
  droppedEvents: number;
  reconnectCount: number;
  lastMessageAt: number | null;
  lastEventAt: number | null;
  eventAgeMs: EventAgeDistribution;
}

const MAX_AGE_SAMPLES = 2_048;

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined) return null;
  if (upperValue === undefined || lower === upper) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

export class StreamTelemetry {
  private readonly ages: number[] = [];
  private messagesReceived = 0;
  private parseErrors = 0;
  private sequenceGaps = 0;
  private staleMessages = 0;
  private droppedEvents = 0;
  private reconnectCount = 0;
  private lastMessageAt: number | null = null;
  private lastEventAt: number | null = null;

  constructor(private readonly staleMessageThresholdMs: number) {
    if (!Number.isFinite(staleMessageThresholdMs) || staleMessageThresholdMs < 0)
      throw new Error('STALE_MESSAGE_THRESHOLD_INVALID');
  }

  recordMessage(receivedAt: number, eventAt: number | null): void {
    this.messagesReceived += 1;
    this.lastMessageAt = receivedAt;
    if (eventAt === null || !Number.isFinite(eventAt)) return;
    this.lastEventAt = eventAt;
    const ageMs = Math.max(0, receivedAt - eventAt);
    this.ages.push(ageMs);
    if (this.ages.length > MAX_AGE_SAMPLES)
      this.ages.splice(0, this.ages.length - MAX_AGE_SAMPLES);
    if (ageMs > this.staleMessageThresholdMs) this.staleMessages += 1;
  }

  recordParseError(): void {
    this.parseErrors += 1;
  }

  recordSequenceGap(): void {
    this.sequenceGaps += 1;
  }

  recordDroppedEvent(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1)
      throw new Error('DROPPED_EVENT_COUNT_INVALID');
    this.droppedEvents += count;
  }

  recordReconnect(): void {
    this.reconnectCount += 1;
  }

  snapshot(): StreamOperationalTelemetry {
    const totalAge = this.ages.reduce((sum, value) => sum + value, 0);
    return {
      messagesReceived: this.messagesReceived,
      parseErrors: this.parseErrors,
      sequenceGaps: this.sequenceGaps,
      staleMessages: this.staleMessages,
      droppedEvents: this.droppedEvents,
      reconnectCount: this.reconnectCount,
      lastMessageAt: this.lastMessageAt,
      lastEventAt: this.lastEventAt,
      eventAgeMs: {
        sampleCount: this.ages.length,
        averageMs: this.ages.length > 0 ? totalAge / this.ages.length : null,
        p95Ms: percentile(this.ages, 0.95),
        p99Ms: percentile(this.ages, 0.99),
        maxMs: this.ages.length > 0 ? Math.max(...this.ages) : null,
      },
    };
  }
}
