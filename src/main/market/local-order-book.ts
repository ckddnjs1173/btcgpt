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
  syncState: OrderBookSyncState;
  lastUpdateId: number | null;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

export type OrderBookSyncState =
  | 'FETCHING_SNAPSHOT'
  | 'WAITING_FOR_BRIDGE'
  | 'SYNCHRONIZED'
  | 'RETRY_SCHEDULED';

export type OrderBookIngestResult =
  | 'APPLIED'
  | 'IGNORED'
  | 'BUFFERED'
  | 'WAITING_FOR_BRIDGE'
  | 'GAP'
  | 'SYNCHRONIZED'
  | 'SNAPSHOT_STALE';

export interface OrderBookSyncDiagnostics {
  syncState: OrderBookSyncState;
  snapshotLastUpdateId: number | null;
  firstBufferedUpdateId: number | null;
  lastBufferedFinalUpdateId: number | null;
  bufferedEventCount: number;
}

const MAX_BUFFERED_EVENTS = 10_000;

export class LocalOrderBook {
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private buffered: DepthDiffEvent[] = [];
  private lastUpdateId: number | null = null;
  private synchronized = false;
  private syncState: OrderBookSyncState = 'FETCHING_SNAPSHOT';
  private pendingSnapshot: DepthSnapshot | null = null;
  private observedSnapshotLastUpdateId: number | null = null;

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.buffered = [];
    this.lastUpdateId = null;
    this.synchronized = false;
    this.syncState = 'FETCHING_SNAPSHOT';
    this.pendingSnapshot = null;
    this.observedSnapshotLastUpdateId = null;
  }

  markFetchingSnapshot(): void {
    this.synchronized = false;
    this.syncState = 'FETCHING_SNAPSHOT';
    this.pendingSnapshot = null;
    this.observedSnapshotLastUpdateId = null;
  }

  markRetryScheduled(): void {
    this.synchronized = false;
    this.syncState = 'RETRY_SCHEDULED';
    this.pendingSnapshot = null;
  }

  buffer(event: DepthDiffEvent): void {
    this.buffered.push(event);
    if (this.buffered.length > MAX_BUFFERED_EVENTS)
      this.buffered.splice(0, this.buffered.length - MAX_BUFFERED_EVENTS);
  }

  initialize(
    snapshot: DepthSnapshot,
  ): 'SYNCHRONIZED' | 'WAITING_FOR_BRIDGE' | 'SNAPSHOT_STALE' {
    this.synchronized = false;
    this.pendingSnapshot = snapshot;
    this.observedSnapshotLastUpdateId = snapshot.lastUpdateId;
    this.buffered = this.buffered.filter(
      (event) => event.finalUpdateId >= snapshot.lastUpdateId,
    );
    return this.tryApplyPendingSnapshot();
  }

  ingest(event: DepthDiffEvent): OrderBookIngestResult {
    if (!this.synchronized || this.lastUpdateId === null) {
      if (
        this.pendingSnapshot &&
        event.finalUpdateId < this.pendingSnapshot.lastUpdateId
      )
        return 'IGNORED';
      this.buffer(event);
      if (this.pendingSnapshot) return this.tryApplyPendingSnapshot();
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
      syncState: this.syncState,
      lastUpdateId: this.lastUpdateId,
      bids: [...this.bids.entries()]
        .sort((left, right) => right[0] - left[0])
        .slice(0, limit),
      asks: [...this.asks.entries()]
        .sort((left, right) => left[0] - right[0])
        .slice(0, limit),
    };
  }

  diagnostics(): OrderBookSyncDiagnostics {
    return {
      syncState: this.syncState,
      snapshotLastUpdateId: this.observedSnapshotLastUpdateId,
      firstBufferedUpdateId: this.buffered[0]?.firstUpdateId ?? null,
      lastBufferedFinalUpdateId:
        this.buffered.at(-1)?.finalUpdateId ?? null,
      bufferedEventCount: this.buffered.length,
    };
  }

  private tryApplyPendingSnapshot():
    | 'SYNCHRONIZED'
    | 'WAITING_FOR_BRIDGE'
    | 'SNAPSHOT_STALE' {
    const snapshot = this.pendingSnapshot;
    if (!snapshot) return 'WAITING_FOR_BRIDGE';
    const firstIndex = this.buffered.findIndex(
      (event) =>
        event.firstUpdateId <= snapshot.lastUpdateId &&
        event.finalUpdateId >= snapshot.lastUpdateId,
    );
    if (firstIndex < 0) {
      const first = this.buffered[0];
      if (first && first.firstUpdateId > snapshot.lastUpdateId) {
        this.pendingSnapshot = null;
        this.syncState = 'RETRY_SCHEDULED';
        return 'SNAPSHOT_STALE';
      }
      this.syncState = 'WAITING_FOR_BRIDGE';
      return 'WAITING_FOR_BRIDGE';
    }

    this.bids.clear();
    this.asks.clear();
    this.applyLevels(this.bids, snapshot.bids);
    this.applyLevels(this.asks, snapshot.asks);
    let appliedUpdateId = snapshot.lastUpdateId;
    for (const event of this.buffered.slice(firstIndex)) {
      if (
        appliedUpdateId !== snapshot.lastUpdateId &&
        event.previousFinalUpdateId !== appliedUpdateId
      ) {
        this.reset();
        this.buffer(event);
        this.syncState = 'RETRY_SCHEDULED';
        return 'SNAPSHOT_STALE';
      }
      this.applyEvent(event);
      appliedUpdateId = event.finalUpdateId;
    }
    this.lastUpdateId = appliedUpdateId;
    this.synchronized = true;
    this.syncState = 'SYNCHRONIZED';
    this.pendingSnapshot = null;
    this.buffered = [];
    return 'SYNCHRONIZED';
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
