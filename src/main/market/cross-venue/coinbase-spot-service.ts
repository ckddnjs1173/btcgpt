import { z } from 'zod';
import { WebSocket as NodeWebSocket } from 'ws';

import {
  COINBASE_SPOT_PRODUCTS,
  type CoinbaseSpotObservation,
  type CoinbaseSpotProduct,
} from '../../../shared/cross-venue-intelligence';
import type { EvidenceHealth } from '../../../shared/market-intelligence';
import { logger } from '../../logging/logger';
import { buildEvidenceHealth } from '../intelligence/freshness';
import { CoinbaseSpotAccumulator } from './coinbase-spot-accumulator';

const WS_URL = 'wss://advanced-trade-ws.coinbase.com';
const MAX_RECONNECT_MS = 30_000;
const HEARTBEAT_STALE_MS = 10_000;
const HEALTH_CHECK_MS = 5_000;
const COINBASE_SPOT_FRESHNESS = {
  freshnessClass: 'AUX_OPTIONAL',
  normalMaxAgeMs: 5_000,
  usableMaxAgeMs: 15_000,
  requiredForEntry: false,
} as const;

const envelopeSchema = z
  .object({
    channel: z.string(),
    timestamp: z.string().optional(),
    sequence_num: z.number().int().nonnegative().optional(),
    events: z.array(z.unknown()).optional(),
  })
  .passthrough();
const tickerEventSchema = z
  .object({
    tickers: z.array(
      z
        .object({
          product_id: z.string(),
          price: z.string(),
          best_bid: z.string().optional(),
          best_ask: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const tradeEventSchema = z
  .object({
    trades: z.array(
      z
        .object({
          product_id: z.string(),
          price: z.string(),
          size: z.string(),
          side: z.enum(['BUY', 'SELL']),
          time: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const level2EventSchema = z
  .object({
    type: z.enum(['snapshot', 'update']),
    product_id: z.string(),
    updates: z.array(
      z
        .object({
          side: z.enum(['bid', 'offer']),
          event_time: z.string(),
          price_level: z.string(),
          new_quantity: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

interface ProductStatus {
  connected: boolean;
  lastMessageAt: number | null;
  lastHeartbeatAt: number | null;
  reconnectCount: number;
  sequenceGapCount: number;
  consecutiveFailures: number;
}

const DEFAULT_DEPENDENCIES = {
  createSocket: () => new NodeWebSocket(WS_URL) as unknown as WebSocket,
  now: () => Date.now(),
};
type CoinbaseDependencies = typeof DEFAULT_DEPENDENCIES;

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTime(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function errorDetails(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : 'UnknownError',
    errorMessage:
      error instanceof Error ? error.message.slice(0, 300) : 'Unknown error',
  };
}

export class CoinbaseSpotMarketService {
  private readonly accumulators = Object.fromEntries(
    COINBASE_SPOT_PRODUCTS.map((product) => [
      product,
      new CoinbaseSpotAccumulator(product),
    ]),
  ) as Record<CoinbaseSpotProduct, CoinbaseSpotAccumulator>;
  private readonly dependencies: CoinbaseDependencies;
  private readonly sockets: Record<CoinbaseSpotProduct, WebSocket | null> = {
    'BTC-USD': null,
    'ETH-USD': null,
    'SOL-USD': null,
  };
  private readonly reconnectTimers: Record<
    CoinbaseSpotProduct,
    NodeJS.Timeout | null
  > = {
    'BTC-USD': null,
    'ETH-USD': null,
    'SOL-USD': null,
  };
  private readonly reconnectAttempts: Record<CoinbaseSpotProduct, number> = {
    'BTC-USD': 0,
    'ETH-USD': 0,
    'SOL-USD': 0,
  };
  private readonly level2Sequences: Record<CoinbaseSpotProduct, number | null> =
    {
      'BTC-USD': null,
      'ETH-USD': null,
      'SOL-USD': null,
    };
  private readonly status: Record<CoinbaseSpotProduct, ProductStatus> = {
    'BTC-USD': this.emptyStatus(),
    'ETH-USD': this.emptyStatus(),
    'SOL-USD': this.emptyStatus(),
  };
  private started = false;
  private stopping = false;
  private runGeneration = 0;
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(dependencies: Partial<CoinbaseDependencies> = {}) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    const runId = ++this.runGeneration;
    for (const product of COINBASE_SPOT_PRODUCTS) this.connect(product, runId);
    this.healthTimer = setInterval(
      () => this.checkHealth(runId),
      HEALTH_CHECK_MS,
    );
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    this.runGeneration += 1;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    for (const product of COINBASE_SPOT_PRODUCTS) {
      const timer = this.reconnectTimers[product];
      if (timer) clearTimeout(timer);
      this.reconnectTimers[product] = null;
      try {
        this.sockets[product]?.close(1000, 'service stop');
      } catch {
        // stop remains authoritative
      }
      this.sockets[product] = null;
      this.status[product].connected = false;
      this.level2Sequences[product] = null;
      this.accumulators[product].resetBook();
    }
  }

  getObservations(
    now = this.dependencies.now(),
  ): Record<CoinbaseSpotProduct, CoinbaseSpotObservation | null> {
    return Object.fromEntries(
      COINBASE_SPOT_PRODUCTS.map((product) => [
        product,
        this.accumulators[product].snapshot({
          now,
          connected: this.status[product].connected,
          lastMessageAt: this.status[product].lastMessageAt,
          lastHeartbeatAt: this.status[product].lastHeartbeatAt,
          reconnectCount: this.status[product].reconnectCount,
          sequenceGapCount: this.status[product].sequenceGapCount,
        }),
      ]),
    ) as Record<CoinbaseSpotProduct, CoinbaseSpotObservation | null>;
  }

  getEvidenceHealth(now = this.dependencies.now()): EvidenceHealth[] {
    const observations = this.getObservations(now);
    return COINBASE_SPOT_PRODUCTS.map((product) => {
      const observation = observations[product];
      const lastSuccessAt = observation?.provenance.reduce<number | null>(
        (latest, row) =>
          latest === null
            ? row.collectorReceivedAt
            : Math.max(latest, row.collectorReceivedAt),
        null,
      );
      return buildEvidenceHealth({
        sourceKey: `cross-venue:coinbase:${product}`,
        ageMs:
          lastSuccessAt === null || lastSuccessAt === undefined
            ? null
            : Math.max(0, now - lastSuccessAt),
        threshold: COINBASE_SPOT_FRESHNESS,
        lastSuccessAt: lastSuccessAt ?? null,
        consecutiveFailures: this.status[product].consecutiveFailures,
        reconnectCount: this.status[product].reconnectCount,
      });
    });
  }

  getStatus(): Record<CoinbaseSpotProduct, ProductStatus> {
    return structuredClone(this.status);
  }

  ingestRecordedMessage(
    product: CoinbaseSpotProduct,
    raw: string,
    receivedAt = this.dependencies.now(),
  ): void {
    this.handleMessage(product, raw, receivedAt, null);
  }

  private emptyStatus(): ProductStatus {
    return {
      connected: false,
      lastMessageAt: null,
      lastHeartbeatAt: null,
      reconnectCount: 0,
      sequenceGapCount: 0,
      consecutiveFailures: 0,
    };
  }

  private isRunActive(runId: number): boolean {
    return this.started && !this.stopping && this.runGeneration === runId;
  }

  private connect(product: CoinbaseSpotProduct, runId: number): void {
    if (!this.isRunActive(runId)) return;
    let socket: WebSocket;
    try {
      socket = this.dependencies.createSocket();
    } catch (error) {
      this.status[product].consecutiveFailures += 1;
      logger.warn(
        { product, ...errorDetails(error) },
        'Coinbase WebSocket creation failed',
      );
      this.scheduleReconnect(product, runId);
      return;
    }
    this.sockets[product] = socket;
    socket.addEventListener('open', () => {
      if (!this.isRunActive(runId) || this.sockets[product] !== socket) return;
      this.reconnectAttempts[product] = 0;
      this.status[product].connected = true;
      this.status[product].consecutiveFailures = 0;
      this.level2Sequences[product] = null;
      this.accumulators[product].resetBook();
      for (const channel of ['heartbeats', 'ticker', 'market_trades', 'level2'])
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            product_ids: [product],
            channel,
          }),
        );
      logger.info({ product }, 'Coinbase public WebSocket connected');
    });
    socket.addEventListener('message', (event) => {
      if (!this.isRunActive(runId) || this.sockets[product] !== socket) return;
      const receivedAt = this.dependencies.now();
      try {
        this.handleMessage(product, String(event.data), receivedAt, socket);
        this.status[product].lastMessageAt = receivedAt;
      } catch (error) {
        logger.warn(
          { product, ...errorDetails(error) },
          'Coinbase WebSocket message rejected',
        );
      }
    });
    socket.addEventListener('error', () => this.fail(product, socket, runId));
    socket.addEventListener('close', () => this.fail(product, socket, runId));
  }

  private handleMessage(
    product: CoinbaseSpotProduct,
    raw: string,
    receivedAt: number,
    socket: WebSocket | null,
  ): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('COINBASE_JSON_INVALID');
    }
    const parsedEnvelope = envelopeSchema.safeParse(decoded);
    if (!parsedEnvelope.success) throw new Error('COINBASE_ENVELOPE_INVALID');
    const envelope = parsedEnvelope.data;
    const envelopeTime = parseTime(envelope.timestamp, receivedAt);
    if (envelope.channel === 'heartbeats') {
      this.status[product].lastHeartbeatAt = receivedAt;
      return;
    }
    if (envelope.channel === 'ticker') {
      for (const event of envelope.events ?? []) {
        const parsed = tickerEventSchema.safeParse(event);
        if (!parsed.success) continue;
        for (const ticker of parsed.data.tickers) {
          if (ticker.product_id !== product) continue;
          const price = toNumber(ticker.price);
          if (price === null) continue;
          this.accumulators[product].ingestTicker({
            eventTime: envelopeTime,
            receivedAt,
            price,
            bestBid: toNumber(ticker.best_bid),
            bestAsk: toNumber(ticker.best_ask),
          });
        }
      }
      return;
    }
    if (envelope.channel === 'market_trades') {
      for (const event of envelope.events ?? []) {
        const parsed = tradeEventSchema.safeParse(event);
        if (!parsed.success) continue;
        for (const trade of parsed.data.trades) {
          if (trade.product_id !== product) continue;
          const price = toNumber(trade.price);
          const size = toNumber(trade.size);
          if (price === null || size === null) continue;
          this.accumulators[product].ingestTrade({
            eventTime: parseTime(trade.time, envelopeTime),
            receivedAt,
            price,
            size,
            makerSide: trade.side,
          });
        }
      }
      return;
    }
    if (envelope.channel === 'level2' || envelope.channel === 'l2_data') {
      const sequence = envelope.sequence_num;
      const previous = this.level2Sequences[product];
      if (
        sequence !== undefined &&
        previous !== null &&
        sequence > previous + 1
      ) {
        this.status[product].sequenceGapCount += 1;
        this.accumulators[product].resetBook();
        this.level2Sequences[product] = null;
        if (socket) socket.close(1011, 'level2 sequence gap');
        return;
      }
      if (sequence !== undefined) {
        if (previous !== null && sequence <= previous) return;
        this.level2Sequences[product] = sequence;
      }
      for (const event of envelope.events ?? []) {
        const parsed = level2EventSchema.safeParse(event);
        if (!parsed.success || parsed.data.product_id !== product) continue;
        const updates = parsed.data.updates.flatMap((update) => {
          const price = toNumber(update.price_level);
          const quantity = toNumber(update.new_quantity);
          if (price === null || quantity === null) return [];
          return [{ side: update.side, price, quantity }];
        });
        const eventTime = parsed.data.updates.reduce(
          (latest, update) =>
            Math.max(latest, parseTime(update.event_time, envelopeTime)),
          envelopeTime,
        );
        if (parsed.data.type === 'snapshot')
          this.accumulators[product].applyBookSnapshot(
            updates,
            eventTime,
            receivedAt,
          );
        else
          this.accumulators[product].applyBookUpdate(
            updates,
            eventTime,
            receivedAt,
          );
      }
      return;
    }
    // Coinbase explicitly allows new message types. Unsupported channels are ignored.
  }

  private fail(
    product: CoinbaseSpotProduct,
    socket: WebSocket,
    runId: number,
  ): void {
    if (this.sockets[product] !== socket) return;
    this.sockets[product] = null;
    this.status[product].connected = false;
    this.status[product].consecutiveFailures += 1;
    this.level2Sequences[product] = null;
    this.accumulators[product].resetBook();
    if (this.isRunActive(runId)) this.scheduleReconnect(product, runId);
  }

  private scheduleReconnect(product: CoinbaseSpotProduct, runId: number): void {
    if (!this.isRunActive(runId) || this.reconnectTimers[product]) return;
    const attempt = this.reconnectAttempts[product]++;
    const delay = Math.min(MAX_RECONNECT_MS, 1_000 * 2 ** Math.min(attempt, 5));
    this.reconnectTimers[product] = setTimeout(() => {
      this.reconnectTimers[product] = null;
      if (!this.isRunActive(runId)) return;
      this.status[product].reconnectCount += 1;
      this.connect(product, runId);
    }, delay);
  }

  private checkHealth(runId: number): void {
    if (!this.isRunActive(runId)) return;
    const now = this.dependencies.now();
    for (const product of COINBASE_SPOT_PRODUCTS) {
      const status = this.status[product];
      if (
        status.connected &&
        status.lastHeartbeatAt !== null &&
        now - status.lastHeartbeatAt > HEARTBEAT_STALE_MS
      ) {
        try {
          this.sockets[product]?.close(1011, 'heartbeat stale');
        } catch {
          // close event or next health cycle will recover the socket
        }
      }
    }
  }
}
