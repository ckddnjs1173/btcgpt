import { createHash, createHmac, randomUUID } from 'node:crypto';
import { WebSocket as NodeWebSocket } from 'ws';

import type {
  ContextStatus,
  ExternalContextHorizon,
  ExternalContextItem,
  ExternalContextSnapshot,
  ExternalContextStatus,
  ExternalSourceHealth,
  RiskContext,
} from '../../shared/contracts';
import { logger } from '../logging/logger';
import { fetchRss, item, officialFeeds, sourceAdapters } from './adapters';

type SourceName =
  | 'BINANCE_ANNOUNCEMENT'
  | 'DERIBIT'
  | 'MEMPOOL_SPACE'
  | 'COIN_METRICS_COMMUNITY'
  | 'ALTERNATIVE_ME'
  | 'FED'
  | 'SEC'
  | 'CFTC'
  | 'BLS'
  | 'GDELT'
  | 'NAVER_NEWS';

const SOURCE_INTERVALS: Record<SourceName, number> = {
  BINANCE_ANNOUNCEMENT: 0,
  DERIBIT: 5 * 60_000,
  MEMPOOL_SPACE: 5 * 60_000,
  COIN_METRICS_COMMUNITY: 15 * 60_000,
  ALTERNATIVE_ME: 6 * 60 * 60_000,
  FED: 30 * 60_000,
  SEC: 30 * 60_000,
  CFTC: 30 * 60_000,
  BLS: 30 * 60_000,
  GDELT: 15 * 60_000,
  NAVER_NEWS: 15 * 60_000,
};
const STALE_AFTER = 2;
const MAX_ITEMS = 600;

function initialHealth(disabled = false): ExternalSourceHealth {
  return {
    status: disabled ? 'DISABLED' : 'INITIALIZING',
    lastSuccess: null,
    lastFailure: null,
    nextAttemptAt: null,
    ageMs: null,
    consecutiveFailures: 0,
    error: null,
  };
}

function normalizedTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, ' ')
    .replace(/\b(the|a|an|and|or|of|to|for|in|on)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class ExternalContextService {
  private readonly items = new Map<string, ExternalContextItem>();
  private readonly health: Record<SourceName, ExternalSourceHealth>;
  private readonly timers = new Map<SourceName, NodeJS.Timeout>();
  private announcementSocket: WebSocket | null = null;
  private announcementRetry: NodeJS.Timeout | null = null;
  private announcementPing: NodeJS.Timeout | null = null;
  private stopped = true;
  private updatedAt: number | null = null;

  constructor(
    private readonly naverCredentials: () => {
      clientId?: string;
      clientSecret?: string;
    } = () => ({}),
    private readonly binanceCredentials: () => {
      apiKey?: string;
      apiSecret?: string;
    } = () => ({}),
  ) {
    const naver = this.naverCredentials();
    this.health = Object.fromEntries(
      (Object.keys(SOURCE_INTERVALS) as SourceName[]).map((source) => [
        source,
        initialHealth(
          (source === 'NAVER_NEWS' &&
            (!naver.clientId || !naver.clientSecret)) ||
            (source === 'BINANCE_ANNOUNCEMENT' &&
              (!this.binanceCredentials().apiKey ||
                !this.binanceCredentials().apiSecret)),
        ),
      ]),
    ) as Record<SourceName, ExternalSourceHealth>;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connectAnnouncements();
    for (const source of Object.keys(SOURCE_INTERVALS) as SourceName[]) {
      if (source === 'BINANCE_ANNOUNCEMENT') continue;
      if (this.health[source].status === 'DISABLED') continue;
      void this.collect(source);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.announcementRetry) clearTimeout(this.announcementRetry);
    if (this.announcementPing) clearInterval(this.announcementPing);
    this.announcementRetry = null;
    this.announcementSocket?.close();
    this.announcementSocket = null;
  }

  reloadNaver(): void {
    const credentials = this.naverCredentials();
    const state = this.health.NAVER_NEWS;
    const timer = this.timers.get('NAVER_NEWS');
    if (timer) clearTimeout(timer);
    this.timers.delete('NAVER_NEWS');
    if (!credentials.clientId || !credentials.clientSecret) {
      Object.assign(state, initialHealth(true));
      return;
    }
    Object.assign(state, initialHealth(false));
    if (!this.stopped) void this.collect('NAVER_NEWS');
  }

  reloadAnnouncements(): void {
    if (this.announcementRetry) clearTimeout(this.announcementRetry);
    if (this.announcementPing) clearInterval(this.announcementPing);
    this.announcementSocket?.close();
    this.announcementSocket = null;
    const credentials = this.binanceCredentials();
    if (!credentials.apiKey || !credentials.apiSecret) {
      Object.assign(this.health.BINANCE_ANNOUNCEMENT, initialHealth(true));
      return;
    }
    Object.assign(this.health.BINANCE_ANNOUNCEMENT, initialHealth(false));
    if (!this.stopped) this.connectAnnouncements();
  }

  getStatus(now = Date.now()): ExternalContextStatus {
    const sourceHealth = this.currentHealth(now);
    return {
      status: this.overallStatus(sourceHealth),
      updatedAt: this.updatedAt,
      riskContext: this.riskContext(now, sourceHealth),
      sourceHealth,
    };
  }

  getSnapshot(
    horizon: ExternalContextHorizon,
    now = Date.now(),
  ): ExternalContextSnapshot {
    const windows = {
      INTRADAY: { past: 24 * 60 * 60_000, future: 24 * 60 * 60_000, max: 40 },
      SWING: {
        past: 7 * 24 * 60 * 60_000,
        future: 14 * 24 * 60 * 60_000,
        max: 80,
      },
      MACRO: {
        past: 30 * 24 * 60 * 60_000,
        future: 90 * 24 * 60 * 60_000,
        max: 120,
      },
    }[horizon];
    const sourceHealth = this.currentHealth(now);
    const items = this.deduplicatedItems()
      .filter(
        (candidate) =>
          candidate.publishedAt >= now - windows.past &&
          candidate.publishedAt <= now + windows.future,
      )
      .sort(
        (a, b) =>
          ({
            OFFICIAL: 0,
            MULTI_SOURCE: 1,
            SINGLE_SOURCE: 2,
            UNVERIFIED_SOCIAL: 3,
          })[a.trustTier] -
            {
              OFFICIAL: 0,
              MULTI_SOURCE: 1,
              SINGLE_SOURCE: 2,
              UNVERIFIED_SOCIAL: 3,
            }[b.trustTier] || b.publishedAt - a.publishedAt,
      )
      .slice(0, windows.max);
    return {
      schemaVersion: 2,
      generatedAt: now,
      status: this.overallStatus(sourceHealth),
      horizon,
      items,
      sourceHealth,
      riskContext: this.riskContext(now, sourceHealth),
    };
  }

  private async collect(
    source: Exclude<SourceName, 'BINANCE_ANNOUNCEMENT'>,
  ): Promise<void> {
    if (this.stopped) return;
    const state = this.health[source];
    try {
      let records: ExternalContextItem[] = [];
      if (source === 'DERIBIT') records = await sourceAdapters.deribit();
      else if (source === 'MEMPOOL_SPACE')
        records = await sourceAdapters.mempool();
      else if (source === 'COIN_METRICS_COMMUNITY')
        records = await sourceAdapters.coinMetrics();
      else if (source === 'ALTERNATIVE_ME')
        records = await sourceAdapters.fearAndGreed();
      else if (source === 'GDELT') records = await sourceAdapters.gdelt();
      else if (source === 'NAVER_NEWS') {
        const credentials = this.naverCredentials();
        records = await sourceAdapters.naver(
          credentials.clientId,
          credentials.clientSecret,
        );
      } else {
        const feed = officialFeeds.find(([name]) => name === source);
        if (feed) records = await fetchRss(feed[0], feed[1], feed[2]);
      }
      this.merge(records);
      state.status = 'NORMAL';
      state.lastSuccess = Date.now();
      state.consecutiveFailures = 0;
      state.error = null;
    } catch (error) {
      state.lastFailure = Date.now();
      state.consecutiveFailures += 1;
      state.status = 'DISCONNECTED';
      state.error =
        error instanceof Error
          ? error.message.slice(0, 120)
          : 'COLLECTION_FAILED';
      logger.warn(
        { source, error: state.error },
        'External context source failed',
      );
    } finally {
      if (!this.stopped) {
        const delay = Math.min(
          SOURCE_INTERVALS[source] * 8,
          SOURCE_INTERVALS[source] *
            2 ** Math.min(3, state.consecutiveFailures),
        );
        state.nextAttemptAt = Date.now() + delay;
        const timer = setTimeout(() => void this.collect(source), delay);
        this.timers.set(source, timer);
      }
    }
  }

  private connectAnnouncements(): void {
    if (this.stopped) return;
    const source = this.health.BINANCE_ANNOUNCEMENT;
    const credentials = this.binanceCredentials();
    if (!credentials.apiKey || !credentials.apiSecret) {
      Object.assign(source, initialHealth(true));
      return;
    }
    const random = randomUUID().replaceAll('-', '');
    const timestamp = Date.now();
    const query = `random=${random}&topic=com_announcement_en&recvWindow=30000&timestamp=${timestamp}`;
    const signature = createHmac('sha256', credentials.apiSecret)
      .update(query)
      .digest('hex');
    const socket = new NodeWebSocket(
      `wss://api.binance.com/sapi/wss?${query}&signature=${signature}`,
      { headers: { 'X-MBX-APIKEY': credentials.apiKey } },
    ) as unknown as WebSocket;
    this.announcementSocket = socket;
    socket.onopen = () => {
      source.status = 'NORMAL';
      source.lastSuccess = Date.now();
      source.consecutiveFailures = 0;
      source.error = null;
      this.announcementPing = setInterval(() => {
        (socket as unknown as NodeWebSocket).ping();
      }, 30_000);
    };
    socket.onmessage = (event) => {
      try {
        const envelope = JSON.parse(String(event.data)) as Record<
          string,
          unknown
        >;
        const raw =
          typeof envelope.data === 'string'
            ? (JSON.parse(envelope.data) as Record<string, unknown>)
            : envelope;
        const titleCandidate = raw.title ?? raw.noticeTitle ?? raw.message;
        const title =
          typeof titleCandidate === 'string' ||
          typeof titleCandidate === 'number'
            ? String(titleCandidate)
            : '';
        if (!title) return;
        const publishedAt = Number(
          raw.publishDate ?? raw.releaseDate ?? raw.E ?? Date.now(),
        );
        const url =
          typeof raw.url === 'string' && raw.url.startsWith('https://')
            ? raw.url
            : 'https://www.binance.com/en/support/announcement';
        this.merge([
          item(
            'BINANCE_ANNOUNCEMENT',
            'BINANCE',
            title,
            url,
            publishedAt,
            Date.now(),
            'OFFICIAL',
            null,
            ['binance-announcement'],
          ),
        ]);
        source.lastSuccess = Date.now();
      } catch {
        source.error = 'INVALID_ANNOUNCEMENT_MESSAGE';
      }
    };
    socket.onerror = () => {
      source.status = 'DISCONNECTED';
      source.lastFailure = Date.now();
      source.consecutiveFailures += 1;
      source.error = 'WEBSOCKET_ERROR';
    };
    socket.onclose = () => {
      if (this.announcementPing) clearInterval(this.announcementPing);
      this.announcementPing = null;
      if (this.stopped) return;
      source.status = 'DISCONNECTED';
      const delay = Math.min(
        5 * 60_000,
        5_000 * 2 ** Math.min(6, source.consecutiveFailures),
      );
      source.nextAttemptAt = Date.now() + delay;
      this.announcementRetry = setTimeout(
        () => this.connectAnnouncements(),
        delay,
      );
    };
  }

  private merge(records: ExternalContextItem[]): void {
    for (const record of records) this.items.set(record.id, record);
    const cutoff = Date.now() - 180 * 24 * 60 * 60_000;
    for (const [id, record] of this.items)
      if (record.publishedAt < cutoff) this.items.delete(id);
    while (this.items.size > MAX_ITEMS) {
      const oldest = [...this.items.values()].sort(
        (a, b) => a.publishedAt - b.publishedAt,
      )[0];
      if (!oldest) break;
      this.items.delete(oldest.id);
    }
    if (records.length) this.updatedAt = Date.now();
  }

  private deduplicatedItems(): ExternalContextItem[] {
    const groups = new Map<string, ExternalContextItem[]>();
    for (const record of this.items.values()) {
      const day = new Date(record.publishedAt).toISOString().slice(0, 10);
      const key = `${normalizedTitle(record.title)}|${day}`;
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, records]) => {
      const preferred = [...records].sort(
        (a, b) =>
          (a.trustTier === 'OFFICIAL' ? -1 : 0) -
          (b.trustTier === 'OFFICIAL' ? -1 : 0),
      )[0]!;
      return {
        ...preferred,
        duplicateGroupId: createHash('sha256')
          .update(key)
          .digest('hex')
          .slice(0, 20),
        duplicateCount: records.length,
        trustTier:
          records.length > 1 && preferred.trustTier !== 'OFFICIAL'
            ? ('MULTI_SOURCE' as const)
            : preferred.trustTier,
      };
    });
  }

  private currentHealth(now: number): Record<string, ExternalSourceHealth> {
    return Object.fromEntries(
      Object.entries(this.health).map(([source, state]) => {
        const interval = SOURCE_INTERVALS[source as SourceName];
        const ageMs =
          state.lastSuccess === null ? null : now - state.lastSuccess;
        let status: ContextStatus = state.status;
        if (
          interval > 0 &&
          ageMs !== null &&
          ageMs > interval * STALE_AFTER &&
          status !== 'DISABLED'
        )
          status = 'STALE';
        return [source, { ...state, status, ageMs }];
      }),
    );
  }

  private overallStatus(
    health: Record<string, ExternalSourceHealth>,
  ): ContextStatus {
    const enabled = Object.values(health).filter(
      (source) => source.status !== 'DISABLED',
    );
    if (!enabled.length) return 'UNAVAILABLE';
    if (enabled.every((source) => source.status === 'INITIALIZING'))
      return 'INITIALIZING';
    if (enabled.every((source) => source.status === 'DISCONNECTED'))
      return 'DISCONNECTED';
    if (enabled.some((source) => source.status === 'STALE')) return 'STALE';
    if (enabled.some((source) => source.status === 'DISCONNECTED'))
      return 'DELAYED';
    return 'NORMAL';
  }

  private riskContext(
    now: number,
    health: Record<string, ExternalSourceHealth>,
  ): RiskContext {
    const recent = this.deduplicatedItems().filter(
      (record) => record.publishedAt >= now - 24 * 60 * 60_000,
    );
    const highRisk = recent.find(
      (record) =>
        record.btcRelevance === 'HIGH' &&
        (record.trustTier === 'OFFICIAL' ||
          record.trustTier === 'MULTI_SOURCE') &&
        /\b(outage|suspend|maintenance|hack|security|fomc|cpi|employment|enforcement|lawsuit)\b/i.test(
          record.title,
        ),
    );
    const fear = recent.find((record) => record.source === 'ALTERNATIVE_ME');
    const fearMatch = fear?.title.match(/(\d+)\s*\(([^)]+)\)/);
    const warnings = Object.entries(health)
      .filter(([, source]) => !['NORMAL', 'DISABLED'].includes(source.status))
      .map(([source, state]) => `${source}:${state.status}`)
      .slice(0, 12);
    return {
      status: this.overallStatus(health),
      updatedAt: this.updatedAt,
      highRiskNews: Boolean(highRisk),
      representativeEventId: highRisk?.id ?? null,
      nextMacroEvent: null,
      binanceCriticalNotice: Boolean(
        highRisk?.source === 'BINANCE_ANNOUNCEMENT',
      ),
      optionsVolatilityState: null,
      onchainAnomaly: false,
      fearAndGreed:
        fear && fearMatch
          ? {
              value: Number(fearMatch[1]),
              classification: fearMatch[2] ?? '',
              at: fear.publishedAt,
            }
          : null,
      sourceWarnings: warnings,
    };
  }
}
