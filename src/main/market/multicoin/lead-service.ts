import { z } from 'zod';
import { WebSocket as NodeWebSocket } from 'ws';

import { numericStringSchema } from '../../binance/schemas';
import { logger } from '../../logging/logger';
import type {
  EvidenceHealth,
  LeadAssetObservation,
} from '../../../shared/market-intelligence';
import {
  buildEvidenceHealth,
  MULTICOIN_FRESHNESS_THRESHOLDS,
} from '../intelligence/freshness';
import { LeadAssetAccumulator, type LeadSymbol } from './lead-accumulator';
import { fetchLeadOpenInterest } from './lead-binance-rest';

const LEAD_SYMBOLS = [
  'ETHUSDT',
  'SOLUSDT',
] as const satisfies readonly LeadSymbol[];
const STREAM_CHANNELS = ['public', 'market'] as const;
type LeadStreamChannel = (typeof STREAM_CHANNELS)[number];

const OI_POLL_MS = 10_000;
const PLANNED_RECONNECT_MS = 23 * 60 * 60_000;
const MAX_RECONNECT_MS = 30_000;

const WS_URLS: Record<LeadStreamChannel, string> = {
  public:
    'wss://fstream.binance.com/public/stream?streams=' +
    LEAD_SYMBOLS.flatMap((symbol) => {
      const streamSymbol = symbol.toLowerCase();
      return [`${streamSymbol}@bookTicker`, `${streamSymbol}@depth20@100ms`];
    }).join('/'),
  market:
    'wss://fstream.binance.com/market/stream?streams=' +
    LEAD_SYMBOLS.flatMap((symbol) => {
      const streamSymbol = symbol.toLowerCase();
      return [
        `${streamSymbol}@aggTrade`,
        `${streamSymbol}@markPrice@1s`,
        `${streamSymbol}@kline_1m`,
        `${streamSymbol}@forceOrder`,
      ];
    }).join('/'),
};

const leadSymbolSchema = z.enum(LEAD_SYMBOLS);
const depthEntrySchema = z.tuple([numericStringSchema, numericStringSchema]);
const streamEnvelopeSchema = z.object({
  stream: z.string(),
  data: z.record(z.string(), z.unknown()),
});
const bookTickerSchema = z.object({
  E: z.number().optional(),
  T: z.number().optional(),
  s: leadSymbolSchema,
  b: numericStringSchema,
  B: numericStringSchema,
  a: numericStringSchema,
  A: numericStringSchema,
});
const partialDepthSchema = z.object({
  E: z.number().optional(),
  T: z.number().optional(),
  s: leadSymbolSchema,
  b: z.array(depthEntrySchema).min(1).max(20),
  a: z.array(depthEntrySchema).min(1).max(20),
});
const aggTradeSchema = z.object({
  E: z.number(),
  s: leadSymbolSchema,
  p: numericStringSchema,
  q: numericStringSchema,
  T: z.number(),
  m: z.boolean(),
});
const markPriceSchema = z.object({
  E: z.number(),
  s: leadSymbolSchema,
  p: numericStringSchema,
  i: numericStringSchema,
  r: numericStringSchema,
  T: z.number(),
});
const klineSchema = z.object({
  E: z.number(),
  s: leadSymbolSchema,
  k: z.object({
    t: z.number(),
    T: z.number(),
    i: z.literal('1m'),
    o: numericStringSchema,
    h: numericStringSchema,
    l: numericStringSchema,
    c: numericStringSchema,
    v: numericStringSchema,
    q: numericStringSchema,
    n: z.number().int().nonnegative(),
    Q: numericStringSchema,
    x: z.boolean(),
  }),
});
const forceOrderSchema = z.object({
  E: z.number(),
  o: z.object({
    s: leadSymbolSchema,
    S: z.enum(['BUY', 'SELL']),
    q: numericStringSchema,
    ap: numericStringSchema,
    p: numericStringSchema,
    T: z.number(),
  }),
});

const DEFAULT_DEPENDENCIES = {
  fetchOpenInterest: fetchLeadOpenInterest,
  createSocket: (url: string) => new NodeWebSocket(url) as unknown as WebSocket,
  now: () => Date.now(),
};
type LeadCoreDependencies = typeof DEFAULT_DEPENDENCIES;

export type LeadCoreServiceStatus = {
  started: boolean;
  streams: Record<
    LeadStreamChannel,
    {
      connected: boolean;
      lastMessageAt: number | null;
      reconnectCount: number;
    }
  >;
  openInterest: Record<
    LeadSymbol,
    {
      lastSuccessAt: number | null;
      consecutiveFailures: number;
    }
  >;
};

function errorDetails(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : 'UnknownError',
    errorMessage:
      error instanceof Error ? error.message.slice(0, 300) : 'Unknown error',
  };
}

export class LeadCoreMarketService {
  private readonly accumulators: Record<LeadSymbol, LeadAssetAccumulator> = {
    ETHUSDT: new LeadAssetAccumulator('ETHUSDT'),
    SOLUSDT: new LeadAssetAccumulator('SOLUSDT'),
  };
  private readonly dependencies: LeadCoreDependencies;
  private readonly sockets: Record<LeadStreamChannel, WebSocket | null> = {
    public: null,
    market: null,
  };
  private readonly reconnectTimers: Record<
    LeadStreamChannel,
    NodeJS.Timeout | null
  > = {
    public: null,
    market: null,
  };
  private readonly plannedReconnectTimers: Record<
    LeadStreamChannel,
    NodeJS.Timeout | null
  > = {
    public: null,
    market: null,
  };
  private readonly reconnectAttempts: Record<LeadStreamChannel, number> = {
    public: 0,
    market: 0,
  };
  private readonly status: LeadCoreServiceStatus = {
    started: false,
    streams: {
      public: { connected: false, lastMessageAt: null, reconnectCount: 0 },
      market: { connected: false, lastMessageAt: null, reconnectCount: 0 },
    },
    openInterest: {
      ETHUSDT: { lastSuccessAt: null, consecutiveFailures: 0 },
      SOLUSDT: { lastSuccessAt: null, consecutiveFailures: 0 },
    },
  };
  private runGeneration = 0;
  private stopping = false;
  private oiTimer: NodeJS.Timeout | null = null;

  constructor(dependencies: Partial<LeadCoreDependencies> = {}) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  start(): void {
    if (this.status.started) return;
    this.status.started = true;
    this.stopping = false;
    const runId = ++this.runGeneration;
    for (const channel of STREAM_CHANNELS) this.connect(channel, runId);
    void this.refreshOpenInterest(runId);
    this.oiTimer = setInterval(() => {
      void this.refreshOpenInterest(runId);
    }, OI_POLL_MS);
  }

  stop(): void {
    if (!this.status.started && this.stopping) return;
    this.stopping = true;
    this.status.started = false;
    this.runGeneration += 1;
    if (this.oiTimer) clearInterval(this.oiTimer);
    this.oiTimer = null;
    for (const channel of STREAM_CHANNELS) {
      const reconnect = this.reconnectTimers[channel];
      const planned = this.plannedReconnectTimers[channel];
      if (reconnect) clearTimeout(reconnect);
      if (planned) clearTimeout(planned);
      this.reconnectTimers[channel] = null;
      this.plannedReconnectTimers[channel] = null;
      try {
        this.sockets[channel]?.close(1000, 'service stop');
      } catch {
        // Stop remains authoritative even if the transport throws.
      }
      this.sockets[channel] = null;
      this.status.streams[channel].connected = false;
    }
  }

  getStatus(): LeadCoreServiceStatus {
    return structuredClone(this.status);
  }

  getObservations(
    now = this.dependencies.now(),
  ): Record<LeadSymbol, LeadAssetObservation | null> {
    return {
      ETHUSDT: this.accumulators.ETHUSDT.snapshot(now),
      SOLUSDT: this.accumulators.SOLUSDT.snapshot(now),
    };
  }

  getEvidenceHealth(now = this.dependencies.now()): EvidenceHealth[] {
    return LEAD_SYMBOLS.flatMap((symbol) => {
      const observation = this.accumulators[symbol].snapshot(now);
      const tradeReceivedAt = this.latestSourceReceivedAt(
        observation,
        'BINANCE_USDM_AGG_TRADE',
      );
      const depthReceivedAt = this.latestSourceReceivedAt(
        observation,
        'BINANCE_USDM_PARTIAL_DEPTH20',
      );
      const oiReceivedAt = this.latestSourceReceivedAt(
        observation,
        'BINANCE_USDM_OPEN_INTEREST',
      );
      const tradeBookReceivedAt = Math.max(
        tradeReceivedAt ?? 0,
        depthReceivedAt ?? 0,
      );
      return [
        buildEvidenceHealth({
          sourceKey: `lead:${symbol}:trade-book`,
          ageMs:
            tradeBookReceivedAt > 0
              ? Math.max(0, now - tradeBookReceivedAt)
              : null,
          threshold: MULTICOIN_FRESHNESS_THRESHOLDS.leadTradeBook,
          lastSuccessAt: tradeBookReceivedAt > 0 ? tradeBookReceivedAt : null,
          reconnectCount:
            this.status.streams.public.reconnectCount +
            this.status.streams.market.reconnectCount,
        }),
        buildEvidenceHealth({
          sourceKey: `lead:${symbol}:open-interest`,
          ageMs: oiReceivedAt === null ? null : Math.max(0, now - oiReceivedAt),
          threshold: MULTICOIN_FRESHNESS_THRESHOLDS.leadOpenInterest,
          lastSuccessAt: this.status.openInterest[symbol].lastSuccessAt,
          consecutiveFailures:
            this.status.openInterest[symbol].consecutiveFailures,
        }),
      ];
    });
  }

  ingestRecordedMessage(
    raw: string,
    receivedAt = this.dependencies.now(),
  ): void {
    this.handleMessage(raw, receivedAt);
  }

  private latestSourceReceivedAt(
    observation: LeadAssetObservation | null,
    source: string,
  ): number | null {
    if (!observation) return null;
    const rows = observation.provenance.filter((row) => row.source === source);
    if (rows.length === 0) return null;
    return Math.max(...rows.map((row) => row.collectorReceivedAt));
  }

  private isRunActive(runId: number): boolean {
    return (
      this.status.started && !this.stopping && this.runGeneration === runId
    );
  }

  private connect(channel: LeadStreamChannel, runId: number): void {
    if (!this.isRunActive(runId)) return;
    let socket: WebSocket;
    try {
      socket = this.dependencies.createSocket(WS_URLS[channel]);
    } catch (error) {
      logger.warn(
        { channel, ...errorDetails(error) },
        'Lead-core WebSocket creation failed',
      );
      this.scheduleReconnect(channel, runId);
      return;
    }

    this.sockets[channel] = socket;
    socket.addEventListener('open', () => {
      if (!this.isRunActive(runId) || this.sockets[channel] !== socket) return;
      this.reconnectAttempts[channel] = 0;
      this.status.streams[channel].connected = true;
      const existing = this.plannedReconnectTimers[channel];
      if (existing) clearTimeout(existing);
      this.plannedReconnectTimers[channel] = setTimeout(
        () => socket.close(1000, 'planned reconnect'),
        PLANNED_RECONNECT_MS,
      );
      logger.info({ channel }, 'Lead-core Binance WebSocket connected');
    });
    socket.addEventListener('message', (event) => {
      if (!this.isRunActive(runId) || this.sockets[channel] !== socket) return;
      const receivedAt = this.dependencies.now();
      try {
        this.handleMessage(String(event.data), receivedAt);
        this.status.streams[channel].lastMessageAt = receivedAt;
      } catch (error) {
        logger.warn(
          { channel, ...errorDetails(error) },
          'Lead-core Binance WebSocket schema validation failed',
        );
      }
    });
    socket.addEventListener('error', () => {
      this.failSocket(channel, socket, runId, true);
    });
    socket.addEventListener('close', () => {
      this.failSocket(channel, socket, runId, false);
    });
  }

  private failSocket(
    channel: LeadStreamChannel,
    socket: WebSocket,
    runId: number,
    closeSocket: boolean,
  ): void {
    if (!this.isRunActive(runId) || this.sockets[channel] !== socket) return;
    const planned = this.plannedReconnectTimers[channel];
    if (planned) clearTimeout(planned);
    this.plannedReconnectTimers[channel] = null;
    this.sockets[channel] = null;
    this.status.streams[channel].connected = false;
    this.status.streams[channel].reconnectCount += 1;
    for (const accumulator of Object.values(this.accumulators)) {
      if (channel === 'public') accumulator.resetPublicStream();
      else accumulator.resetMarketStream();
    }
    if (closeSocket)
      try {
        socket.close();
      } catch {
        // Reconnect timer below is authoritative.
      }
    this.scheduleReconnect(channel, runId);
  }

  private scheduleReconnect(channel: LeadStreamChannel, runId: number): void {
    if (!this.isRunActive(runId) || this.reconnectTimers[channel]) return;
    const base = Math.min(
      MAX_RECONNECT_MS,
      1_000 * 2 ** this.reconnectAttempts[channel],
    );
    const delay = Math.max(250, Math.round(base * (0.8 + Math.random() * 0.4)));
    this.reconnectAttempts[channel] += 1;
    this.reconnectTimers[channel] = setTimeout(() => {
      this.reconnectTimers[channel] = null;
      this.connect(channel, runId);
    }, delay);
  }

  private async refreshOpenInterest(runId: number): Promise<void> {
    const results = await Promise.allSettled(
      LEAD_SYMBOLS.map(async (symbol) => ({
        symbol,
        value: await this.dependencies.fetchOpenInterest(symbol),
      })),
    );
    if (!this.isRunActive(runId)) return;
    const receivedAt = this.dependencies.now();
    results.forEach((result, index) => {
      const fallbackSymbol = LEAD_SYMBOLS[index];
      if (!fallbackSymbol) return;
      if (result.status === 'fulfilled') {
        const { symbol, value } = result.value;
        this.accumulators[symbol].recordOpenInterest({
          openInterest: Number(value.openInterest),
          observedAt: value.time,
          receivedAt,
        });
        this.status.openInterest[symbol].lastSuccessAt = receivedAt;
        this.status.openInterest[symbol].consecutiveFailures = 0;
      } else {
        this.status.openInterest[fallbackSymbol].consecutiveFailures += 1;
        logger.warn(
          { symbol: fallbackSymbol, ...errorDetails(result.reason) },
          'Lead-core open interest refresh failed',
        );
      }
    });
  }

  private handleMessage(raw: string, receivedAt: number): void {
    const envelope = streamEnvelopeSchema.parse(JSON.parse(raw) as unknown);
    if (envelope.stream.endsWith('@bookTicker')) {
      const event = bookTickerSchema.parse(envelope.data);
      this.accumulators[event.s].recordBookTicker({
        bidPrice: Number(event.b),
        bidQuantity: Number(event.B),
        askPrice: Number(event.a),
        askQuantity: Number(event.A),
        eventAt: event.T ?? event.E ?? receivedAt,
        receivedAt,
      });
      return;
    }

    if (envelope.stream.includes('@depth20')) {
      const event = partialDepthSchema.parse(envelope.data);
      this.accumulators[event.s].recordDepth({
        bids: event.b.map(([price, quantity]) => [
          Number(price),
          Number(quantity),
        ]),
        asks: event.a.map(([price, quantity]) => [
          Number(price),
          Number(quantity),
        ]),
        eventAt: event.T ?? event.E ?? receivedAt,
        receivedAt,
      });
      return;
    }

    if (envelope.stream.endsWith('@aggTrade')) {
      const event = aggTradeSchema.parse(envelope.data);
      this.accumulators[event.s].recordTrade({
        price: Number(event.p),
        quantity: Number(event.q),
        buyerIsMaker: event.m,
        eventAt: event.T,
        receivedAt,
      });
      return;
    }

    if (envelope.stream.includes('@markPrice')) {
      const event = markPriceSchema.parse(envelope.data);
      this.accumulators[event.s].recordMark({
        markPrice: Number(event.p),
        indexPrice: Number(event.i),
        fundingRate: Number(event.r),
        nextFundingTime: event.T,
        eventAt: event.E,
        receivedAt,
      });
      return;
    }

    if (envelope.stream.endsWith('@kline_1m')) {
      const event = klineSchema.parse(envelope.data);
      if (!event.k.x) return;
      this.accumulators[event.s].recordClosedOneMinuteCandle({
        openTime: event.k.t,
        closeTime: event.k.T,
        open: Number(event.k.o),
        high: Number(event.k.h),
        low: Number(event.k.l),
        close: Number(event.k.c),
        volume: Number(event.k.v),
        quoteVolume: Number(event.k.q),
        tradeCount: event.k.n,
        takerBuyQuoteVolume: Number(event.k.Q),
        closed: true,
      });
      return;
    }

    if (envelope.stream.endsWith('@forceOrder')) {
      const event = forceOrderSchema.parse(envelope.data);
      const averagePrice = Number(event.o.ap);
      const orderPrice = Number(event.o.p);
      this.accumulators[event.o.s].recordLiquidation({
        side: event.o.S,
        quantity: Number(event.o.q),
        price: averagePrice > 0 ? averagePrice : orderPrice,
        eventAt: event.o.T,
        receivedAt,
      });
      return;
    }

    throw new Error(`UNSUPPORTED_LEAD_STREAM:${envelope.stream}`);
  }
}
