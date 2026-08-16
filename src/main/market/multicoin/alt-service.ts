import { z } from 'zod';
import { WebSocket as NodeWebSocket } from 'ws';

import {
  SENTIMENT_CORE_SYMBOLS,
  type AltAssetObservation,
  type AltMarketIntelligence,
  type DynamicBasket,
  type DynamicBasketCandidate,
} from '../../../shared/alt-market-intelligence';
import type { EvidenceHealth } from '../../../shared/market-intelligence';
import { numericStringSchema } from '../../binance/schemas';
import { logger } from '../../logging/logger';
import { buildAltMarketIntelligence } from '../intelligence/alt-market';
import {
  buildEvidenceHealth,
  MULTICOIN_FRESHNESS_THRESHOLDS,
} from '../intelligence/freshness';
import { AltAssetAccumulator } from './alt-accumulator';
import {
  fetchGenericOpenInterest,
  scanDynamicBasketCandidates,
} from './alt-binance-rest';
import {
  DYNAMIC_BASKET_REBALANCE_MS,
  selectDynamicBasket,
} from './dynamic-basket';

const OI_POLL_MS = 30_000;
const PLANNED_RECONNECT_MS = 23 * 60 * 60_000;
const MAX_RECONNECT_MS = 30_000;
const CHANNELS = ['public', 'market'] as const;
type AltStreamChannel = (typeof CHANNELS)[number];

const DEFAULT_DEPENDENCIES = {
  scanCandidates: scanDynamicBasketCandidates,
  fetchOpenInterest: fetchGenericOpenInterest,
  createSocket: (url: string) => new NodeWebSocket(url) as unknown as WebSocket,
  now: () => Date.now(),
};
type AltServiceDependencies = typeof DEFAULT_DEPENDENCIES;

const streamEnvelopeSchema = z.object({
  stream: z.string(),
  data: z.record(z.string(), z.unknown()),
});
const genericSymbolSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[A-Z0-9-]+$/);
const bookTickerSchema = z.object({
  E: z.number().optional(),
  T: z.number().optional(),
  s: genericSymbolSchema,
  b: numericStringSchema,
  a: numericStringSchema,
});
const aggTradeSchema = z.object({
  E: z.number(),
  s: genericSymbolSchema,
  p: numericStringSchema,
  q: numericStringSchema,
  T: z.number(),
  m: z.boolean(),
});
const markPriceSchema = z.object({
  E: z.number(),
  s: genericSymbolSchema,
  p: numericStringSchema,
  r: numericStringSchema,
});
const forceOrderSchema = z.object({
  E: z.number(),
  o: z.object({
    s: genericSymbolSchema,
    S: z.enum(['BUY', 'SELL']),
    q: numericStringSchema,
    ap: numericStringSchema,
    p: numericStringSchema,
    T: z.number(),
  }),
});

function details(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : 'UnknownError',
    errorMessage:
      error instanceof Error ? error.message.slice(0, 300) : 'Unknown error',
  };
}

function baseAssetFromSymbol(symbol: string): string {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
}

function clearTimer(timer: NodeJS.Timeout | null): void {
  if (timer) clearTimeout(timer);
}

export class AltMarketService {
  private readonly dependencies: AltServiceDependencies;
  private readonly accumulators = new Map<string, AltAssetAccumulator>();
  private basket: DynamicBasket | null = null;
  private candidates: DynamicBasketCandidate[] = [];
  private activeSymbols: string[] = [...SENTIMENT_CORE_SYMBOLS];
  private readonly sockets: Record<AltStreamChannel, WebSocket | null> = {
    public: null,
    market: null,
  };
  private readonly reconnectTimers: Record<
    AltStreamChannel,
    NodeJS.Timeout | null
  > = {
    public: null,
    market: null,
  };
  private readonly plannedReconnectTimers: Record<
    AltStreamChannel,
    NodeJS.Timeout | null
  > = {
    public: null,
    market: null,
  };
  private readonly reconnectAttempts: Record<AltStreamChannel, number> = {
    public: 0,
    market: 0,
  };
  private readonly reconnectCounts: Record<AltStreamChannel, number> = {
    public: 0,
    market: 0,
  };
  private readonly oiFailures = new Map<string, number>();
  private readonly oiLastSuccess = new Map<string, number>();
  private started = false;
  private stopping = false;
  private runGeneration = 0;
  private streamGeneration = 0;
  private scanTimer: NodeJS.Timeout | null = null;
  private oiTimer: NodeJS.Timeout | null = null;

  constructor(dependencies: Partial<AltServiceDependencies> = {}) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    for (const symbol of SENTIMENT_CORE_SYMBOLS)
      this.ensureAccumulator(symbol, 'SENTIMENT_CORE');
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    const runId = ++this.runGeneration;
    this.rebuildStreams(runId);
    void this.refreshBasket(runId);
    void this.refreshOpenInterest(runId);
    this.scanTimer = setInterval(() => {
      void this.refreshBasket(runId);
    }, DYNAMIC_BASKET_REBALANCE_MS);
    this.oiTimer = setInterval(() => {
      void this.refreshOpenInterest(runId);
    }, OI_POLL_MS);
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    this.runGeneration += 1;
    this.streamGeneration += 1;
    clearTimer(this.scanTimer);
    clearTimer(this.oiTimer);
    this.scanTimer = null;
    this.oiTimer = null;
    for (const channel of CHANNELS) {
      clearTimer(this.reconnectTimers[channel]);
      clearTimer(this.plannedReconnectTimers[channel]);
      this.reconnectTimers[channel] = null;
      this.plannedReconnectTimers[channel] = null;
      try {
        this.sockets[channel]?.close(1000, 'service stop');
      } catch {
        // Stop remains authoritative even if the transport throws.
      }
      this.sockets[channel] = null;
    }
  }

  getBasket(): DynamicBasket | null {
    return this.basket ? structuredClone(this.basket) : null;
  }

  getObservations(now = this.dependencies.now()): {
    sentimentCore: AltAssetObservation[];
    dynamic: AltAssetObservation[];
  } {
    const dynamicSet = new Set(
      this.basket?.members.map((member) => member.symbol) ?? [],
    );
    const observations = [...this.accumulators.values()]
      .map((accumulator) => accumulator.snapshot(now))
      .filter((row): row is AltAssetObservation => row !== null);
    return {
      sentimentCore: observations
        .filter((row) => row.tier === 'SENTIMENT_CORE')
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
      dynamic: observations
        .filter((row) => row.tier === 'DYNAMIC' && dynamicSet.has(row.symbol))
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    };
  }

  getEvidenceHealth(now = this.dependencies.now()): EvidenceHealth[] {
    return this.activeSymbols.flatMap((symbol) => {
      const observation = this.accumulators.get(symbol)?.snapshot(now) ?? null;
      const marketTimes =
        observation?.provenance
          .filter((row) => row.source !== 'BINANCE_USDM_ALT_OPEN_INTEREST')
          .map((row) => row.collectorReceivedAt) ?? [];
      const marketReceivedAt =
        marketTimes.length > 0 ? Math.max(...marketTimes) : null;
      const observationOiReceivedAt = observation?.provenance.find(
        (row) => row.source === 'BINANCE_USDM_ALT_OPEN_INTEREST',
      )?.collectorReceivedAt;
      const oiReceivedAt =
        observationOiReceivedAt ?? this.oiLastSuccess.get(symbol) ?? null;
      return [
        buildEvidenceHealth({
          sourceKey: `alt:${symbol}:market`,
          ageMs:
            marketReceivedAt === null
              ? null
              : Math.max(0, now - marketReceivedAt),
          threshold: MULTICOIN_FRESHNESS_THRESHOLDS.dynamicPrice,
          lastSuccessAt: marketReceivedAt,
          reconnectCount:
            this.reconnectCounts.public + this.reconnectCounts.market,
        }),
        buildEvidenceHealth({
          sourceKey: `alt:${symbol}:open-interest`,
          ageMs: oiReceivedAt === null ? null : Math.max(0, now - oiReceivedAt),
          threshold: MULTICOIN_FRESHNESS_THRESHOLDS.dynamicOpenInterest,
          lastSuccessAt: this.oiLastSuccess.get(symbol) ?? null,
          consecutiveFailures: this.oiFailures.get(symbol) ?? 0,
        }),
      ];
    });
  }

  buildIntelligence(
    btcReturnsBps: Partial<
      Record<'1m' | '3m' | '5m' | '15m' | '1h', number | null>
    > = {},
    now = this.dependencies.now(),
  ): AltMarketIntelligence | null {
    if (!this.basket) return null;
    const observations = this.getObservations(now);
    return buildAltMarketIntelligence({
      generatedAt: now,
      basket: this.basket,
      sentimentCore: observations.sentimentCore,
      dynamic: observations.dynamic,
      candidates: this.candidates,
      btcReturnsBps,
      evidenceHealth: this.getEvidenceHealth(now),
    });
  }

  ingestRecordedMessage(
    raw: string,
    receivedAt = this.dependencies.now(),
  ): void {
    this.handleMessage(raw, receivedAt);
  }

  applyCandidatesForTest(
    candidates: DynamicBasketCandidate[],
    now: number,
  ): void {
    this.applyCandidates(candidates, now, false);
  }

  private isActive(runId: number): boolean {
    return this.started && !this.stopping && this.runGeneration === runId;
  }

  private ensureAccumulator(
    symbol: string,
    tier: 'SENTIMENT_CORE' | 'DYNAMIC',
    baseAsset = baseAssetFromSymbol(symbol),
  ): AltAssetAccumulator {
    const existing = this.accumulators.get(symbol);
    if (existing) {
      existing.setTier(tier);
      return existing;
    }
    const accumulator = new AltAssetAccumulator(symbol, baseAsset, tier);
    this.accumulators.set(symbol, accumulator);
    return accumulator;
  }

  private async refreshBasket(runId: number): Promise<void> {
    try {
      const candidates = await this.dependencies.scanCandidates(
        this.dependencies.now(),
      );
      if (!this.isActive(runId)) return;
      this.applyCandidates(candidates, this.dependencies.now(), true, runId);
    } catch (error) {
      logger.warn(
        details(error),
        'Dynamic alt basket scan failed; keeping previous basket',
      );
    }
  }

  private applyCandidates(
    candidates: DynamicBasketCandidate[],
    now: number,
    rebuild: boolean,
    runId = this.runGeneration,
  ): void {
    const sentimentSet = new Set<string>(SENTIMENT_CORE_SYMBOLS);
    const dynamicCandidates = candidates.filter(
      (candidate) => !sentimentSet.has(candidate.symbol),
    );
    const previousSymbols = this.activeSymbols.join(',');
    this.candidates = dynamicCandidates;
    this.basket = selectDynamicBasket({
      generatedAt: now,
      candidates: dynamicCandidates,
      previous: this.basket,
    });
    const candidateBySymbol = new Map(
      dynamicCandidates.map((candidate) => [candidate.symbol, candidate]),
    );
    for (const member of this.basket.members) {
      const candidate = candidateBySymbol.get(member.symbol);
      this.ensureAccumulator(member.symbol, 'DYNAMIC', candidate?.baseAsset);
    }
    for (const symbol of SENTIMENT_CORE_SYMBOLS)
      this.ensureAccumulator(symbol, 'SENTIMENT_CORE');
    this.activeSymbols = [
      ...SENTIMENT_CORE_SYMBOLS,
      ...this.basket.members.map((member) => member.symbol),
    ]
      .filter((symbol, index, rows) => rows.indexOf(symbol) === index)
      .sort((a, b) => a.localeCompare(b));
    if (
      rebuild &&
      previousSymbols !== this.activeSymbols.join(',') &&
      this.isActive(runId)
    )
      this.rebuildStreams(runId);
  }

  private streamUrl(channel: AltStreamChannel): string {
    const streams = this.activeSymbols.flatMap((symbol) => {
      const lower = symbol.toLowerCase();
      return channel === 'public'
        ? [`${lower}@bookTicker`]
        : [`${lower}@aggTrade`, `${lower}@markPrice@1s`, `${lower}@forceOrder`];
    });
    return `wss://fstream.binance.com/${channel}/stream?streams=${streams.join('/')}`;
  }

  private rebuildStreams(runId: number): void {
    if (!this.isActive(runId)) return;
    const generation = ++this.streamGeneration;
    for (const channel of CHANNELS) {
      clearTimer(this.reconnectTimers[channel]);
      clearTimer(this.plannedReconnectTimers[channel]);
      this.reconnectTimers[channel] = null;
      this.plannedReconnectTimers[channel] = null;
      const old = this.sockets[channel];
      this.sockets[channel] = null;
      try {
        old?.close(1000, 'symbol set changed');
      } catch {
        // The new stream generation is authoritative.
      }
      this.connect(channel, runId, generation);
    }
  }

  private connect(
    channel: AltStreamChannel,
    runId: number,
    generation: number,
  ): void {
    if (!this.isActive(runId) || generation !== this.streamGeneration) return;
    let socket: WebSocket;
    try {
      socket = this.dependencies.createSocket(this.streamUrl(channel));
    } catch (error) {
      logger.warn(
        { channel, ...details(error) },
        'Alt-market websocket creation failed',
      );
      this.scheduleReconnect(channel, runId, generation);
      return;
    }

    this.sockets[channel] = socket;
    socket.addEventListener('open', () => {
      if (!this.isCurrentSocket(channel, socket, runId, generation)) return;
      this.reconnectAttempts[channel] = 0;
      clearTimer(this.plannedReconnectTimers[channel]);
      this.plannedReconnectTimers[channel] = setTimeout(
        () => socket.close(1000, 'planned reconnect'),
        PLANNED_RECONNECT_MS,
      );
    });
    socket.addEventListener('message', (event) => {
      if (!this.isCurrentSocket(channel, socket, runId, generation)) return;
      try {
        this.handleMessage(String(event.data), this.dependencies.now());
      } catch (error) {
        logger.warn(
          { channel, ...details(error) },
          'Alt-market websocket schema validation failed',
        );
      }
    });
    socket.addEventListener('error', () => {
      this.failSocket(channel, socket, runId, generation, true);
    });
    socket.addEventListener('close', () => {
      this.failSocket(channel, socket, runId, generation, false);
    });
  }

  private isCurrentSocket(
    channel: AltStreamChannel,
    socket: WebSocket,
    runId: number,
    generation: number,
  ): boolean {
    return (
      this.isActive(runId) &&
      generation === this.streamGeneration &&
      this.sockets[channel] === socket
    );
  }

  private failSocket(
    channel: AltStreamChannel,
    socket: WebSocket,
    runId: number,
    generation: number,
    closeSocket: boolean,
  ): void {
    if (!this.isCurrentSocket(channel, socket, runId, generation)) return;
    this.sockets[channel] = null;
    this.reconnectCounts[channel] += 1;
    clearTimer(this.plannedReconnectTimers[channel]);
    this.plannedReconnectTimers[channel] = null;
    for (const symbol of this.activeSymbols) {
      const accumulator = this.accumulators.get(symbol);
      if (!accumulator) continue;
      if (channel === 'public') accumulator.resetPublicStream();
      else accumulator.resetMarketStream();
    }
    if (closeSocket)
      try {
        socket.close();
      } catch {
        // The reconnect timer below is authoritative.
      }
    this.scheduleReconnect(channel, runId, generation);
  }

  private scheduleReconnect(
    channel: AltStreamChannel,
    runId: number,
    generation: number,
  ): void {
    if (
      !this.isActive(runId) ||
      generation !== this.streamGeneration ||
      this.reconnectTimers[channel]
    )
      return;
    const base = Math.min(
      MAX_RECONNECT_MS,
      1_000 * 2 ** this.reconnectAttempts[channel],
    );
    const delay = Math.max(250, Math.round(base * (0.8 + Math.random() * 0.4)));
    this.reconnectAttempts[channel] += 1;
    this.reconnectTimers[channel] = setTimeout(() => {
      this.reconnectTimers[channel] = null;
      this.connect(channel, runId, generation);
    }, delay);
  }

  private async refreshOpenInterest(runId: number): Promise<void> {
    const symbols = [...this.activeSymbols];
    const results = await Promise.allSettled(
      symbols.map(async (symbol) => ({
        symbol,
        response: await this.dependencies.fetchOpenInterest(symbol),
      })),
    );
    if (!this.isActive(runId)) return;
    const receivedAt = this.dependencies.now();
    results.forEach((result, index) => {
      const symbol = symbols[index];
      if (!symbol) return;
      if (result.status === 'fulfilled') {
        this.accumulators.get(symbol)?.recordOpenInterest({
          value: Number(result.value.response.openInterest),
          observedAt: result.value.response.time,
          receivedAt,
        });
        this.oiFailures.set(symbol, 0);
        this.oiLastSuccess.set(symbol, receivedAt);
      } else {
        this.oiFailures.set(symbol, (this.oiFailures.get(symbol) ?? 0) + 1);
      }
    });
  }

  private activeAccumulator(symbol: string): AltAssetAccumulator {
    const accumulator = this.accumulators.get(symbol);
    if (!accumulator || !this.activeSymbols.includes(symbol))
      throw new Error(`INACTIVE_ALT_SYMBOL:${symbol}`);
    return accumulator;
  }

  private handleMessage(raw: string, receivedAt: number): void {
    const envelope = streamEnvelopeSchema.parse(JSON.parse(raw) as unknown);
    if (envelope.stream.endsWith('@bookTicker')) {
      const event = bookTickerSchema.parse(envelope.data);
      this.activeAccumulator(event.s).recordBook({
        bidPrice: Number(event.b),
        askPrice: Number(event.a),
        eventAt: event.T ?? event.E ?? receivedAt,
        receivedAt,
      });
      return;
    }
    if (envelope.stream.endsWith('@aggTrade')) {
      const event = aggTradeSchema.parse(envelope.data);
      this.activeAccumulator(event.s).recordTrade({
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
      this.activeAccumulator(event.s).recordMark({
        markPrice: Number(event.p),
        fundingRate: Number(event.r),
        eventAt: event.E,
        receivedAt,
      });
      return;
    }
    if (envelope.stream.endsWith('@forceOrder')) {
      const event = forceOrderSchema.parse(envelope.data);
      const averagePrice = Number(event.o.ap);
      this.activeAccumulator(event.o.s).recordLiquidation({
        side: event.o.S,
        price: averagePrice > 0 ? averagePrice : Number(event.o.p),
        quantity: Number(event.o.q),
        eventAt: event.o.T,
        receivedAt,
      });
      return;
    }
    throw new Error(`UNSUPPORTED_ALT_STREAM:${envelope.stream}`);
  }
}
