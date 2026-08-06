export interface DepthDiffEvent {
  eventTime: number;
  firstUpdateId: number;
  finalUpdateId: number;
  previousFinalUpdateId: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

export interface DepthSnapshot {
  lastUpdateId: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

export interface LocalOrderBookView {
  synchronized: boolean;
  lastUpdateId: number | null;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

const MAX_BUFFERED_EVENTS = 10_000;

export class LocalOrderBook {
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private buffered: DepthDiffEvent[] = [];
  private lastUpdateId: number | null = null;
  private synchronized = false;

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.buffered = [];
    this.lastUpdateId = null;
    this.synchronized = false;
  }

  buffer(event: DepthDiffEvent): void {
    this.buffered.push(event);
    if (this.buffered.length > MAX_BUFFERED_EVENTS)
      this.buffered.splice(0, this.buffered.length - MAX_BUFFERED_EVENTS);
  }

  initialize(snapshot: DepthSnapshot): boolean {
    this.bids.clear();
    this.asks.clear();
    this.applyLevels(this.bids, snapshot.bids);
    this.applyLevels(this.asks, snapshot.asks);

    const relevant = this.buffered.filter(
      (event) => event.finalUpdateId >= snapshot.lastUpdateId,
    );
    const firstIndex = relevant.findIndex(
      (event) =>
        event.firstUpdateId <= snapshot.lastUpdateId &&
        event.finalUpdateId >= snapshot.lastUpdateId,
    );
    if (firstIndex < 0 && relevant.length > 0) {
      this.reset();
      for (const event of relevant) this.buffer(event);
      return false;
    }

    let appliedUpdateId = snapshot.lastUpdateId;
    if (firstIndex >= 0) {
      for (const event of relevant.slice(firstIndex)) {
        if (
          appliedUpdateId !== snapshot.lastUpdateId &&
          event.previousFinalUpdateId !== appliedUpdateId
        ) {
          this.reset();
          this.buffer(event);
          return false;
        }
        this.applyEvent(event);
        appliedUpdateId = event.finalUpdateId;
      }
    }

    this.lastUpdateId = appliedUpdateId;
    this.synchronized = true;
    this.buffered = [];
    return true;
  }

  ingest(event: DepthDiffEvent): 'APPLIED' | 'IGNORED' | 'BUFFERED' | 'GAP' {
    if (!this.synchronized || this.lastUpdateId === null) {
      this.buffer(event);
      return 'BUFFERED';
    }
    if (event.finalUpdateId < this.lastUpdateId) return 'IGNORED';
    if (event.previousFinalUpdateId !== this.lastUpdateId) {
      this.reset();
      this.buffer(event);
      return 'GAP';
    }
    this.applyEvent(event);
    this.lastUpdateId = event.finalUpdateId;
    return 'APPLIED';
  }

  view(limit = 100): LocalOrderBookView {
    return {
      synchronized: this.synchronized,
      lastUpdateId: this.lastUpdateId,
      bids: [...this.bids.entries()]
        .sort((left, right) => right[0] - left[0])
        .slice(0, limit),
      asks: [...this.asks.entries()]
        .sort((left, right) => left[0] - right[0])
        .slice(0, limit),
    };
  }

  private applyEvent(event: DepthDiffEvent): void {
    this.applyLevels(this.bids, event.bids);
    this.applyLevels(this.asks, event.asks);
  }

  private applyLevels(
    side: Map<number, number>,
    levels: Array<[number, number]>,
  ): void {
    for (const [price, quantity] of levels) {
      if (quantity === 0) side.delete(price);
      else side.set(price, quantity);
    }
  }
}
