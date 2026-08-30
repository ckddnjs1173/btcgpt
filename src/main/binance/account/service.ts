import { WebSocket as NodeWebSocket } from 'ws';

import type {
  AccountConfigurationInput,
  AccountStatus,
} from '../../../shared/contracts';
import { logger } from '../../logging/logger';
import type { CredentialStore } from '../../security/credential-store';
import { BinanceAccountClient } from './rest';

const PRIVATE_STREAM_URL = 'wss://fstream.binance.com/private/ws';
const STREAM_KEEPALIVE_MS = 50 * 60_000;
export const ACCOUNT_STREAM_EVENTS = [
  'ORDER_TRADE_UPDATE',
  'ACCOUNT_UPDATE',
  'ACCOUNT_CONFIG_UPDATE',
  'ALGO_UPDATE',
] as const;
const ACCOUNT_REFRESH_EVENTS = new Set<string>(ACCOUNT_STREAM_EVENTS);

export function buildUserDataStreamUrl(listenKey: string): string {
  return `${PRIVATE_STREAM_URL}?listenKey=${encodeURIComponent(listenKey)}&events=${ACCOUNT_STREAM_EVENTS.join('/')}`;
}

export function shouldRefreshAccountForEvent(eventType: string): boolean {
  return ACCOUNT_REFRESH_EVENTS.has(eventType);
}

function streamStatus(
  overrides: Partial<AccountStatus['stream']> = {},
): AccountStatus['stream'] {
  return {
    status: 'DISCONNECTED',
    lastEventAt: null,
    lastAccountUpdateAt: null,
    lastOrderTradeUpdateAt: null,
    reconnectCount: 0,
    error: null,
    ...overrides,
  };
}

function emptyStatus(configured: boolean): AccountStatus {
  return {
    configured,
    connected: false,
    lastUpdatedAt: null,
    error: null,
    stream: streamStatus(),
    position: null,
    commission: null,
    balance: null,
    openOrders: [],
    recentTrades: [],
    leverageBrackets: [],
  };
}

export class AccountService {
  private status: AccountStatus;
  private timer: NodeJS.Timeout | null = null;
  private socket: NodeWebSocket | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private refreshDebounceTimer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private listenKeyActive = false;
  private reconnectAttempts = 0;
  private stopping = false;

  constructor(
    private readonly credentials: CredentialStore,
    private readonly getServerOffsetMs: () => number = () => 0,
  ) {
    this.status = emptyStatus(credentials.hasCredentials());
  }

  start(): void {
    if (!this.status.configured) return;
    this.stopping = false;
    void this.refresh();
    this.ensurePollTimer();
    void this.connectStream();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshDebounceTimer) clearTimeout(this.refreshDebounceTimer);
    this.timer = null;
    this.keepAliveTimer = null;
    this.reconnectTimer = null;
    this.refreshDebounceTimer = null;
    this.socket?.close();
    this.socket = null;
    void this.closeListenKey();
  }

  async configure(input: AccountConfigurationInput): Promise<void> {
    const client = this.createClient(input);
    const snapshot = await this.fetchSnapshot(client);
    this.credentials.save(input);
    this.stopping = false;
    this.status = {
      configured: true,
      connected: true,
      lastUpdatedAt: Date.now(),
      error: null,
      stream: streamStatus(),
      ...snapshot,
    };
    this.ensurePollTimer();
    await this.connectStream();
  }

  disconnect(): void {
    this.stop();
    this.credentials.clear();
    this.status = emptyStatus(false);
  }

  getStatus(): AccountStatus {
    return structuredClone(this.status);
  }

  private createClient(input: AccountConfigurationInput): BinanceAccountClient {
    const offset = this.getServerOffsetMs();
    if (Math.abs(offset) > 10_000)
      throw new Error('System clock differs too much from Binance server time');
    return new BinanceAccountClient(input, fetch, offset);
  }

  private async fetchSnapshot(client: BinanceAccountClient) {
    const [
      position,
      commission,
      balance,
      openOrders,
      recentTrades,
      leverageBrackets,
    ] = await Promise.all([
      client.fetchPosition(),
      client.fetchCommission(),
      client.fetchAvailableBalance(),
      client.fetchOpenOrders(),
      client.fetchRecentTrades(),
      client.fetchLeverageBrackets(),
    ]);
    return {
      position,
      commission,
      balance,
      openOrders,
      recentTrades,
      leverageBrackets,
    };
  }

  private ensurePollTimer(): void {
    if (!this.timer)
      this.timer = setInterval(() => void this.refresh(), 30_000);
  }

  private refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.performRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<void> {
    const stored = this.credentials.load();
    if (!stored) return;
    try {
      const client = this.createClient(stored);
      const snapshot = await this.fetchSnapshot(client);
      this.status = {
        ...this.status,
        configured: true,
        connected: true,
        lastUpdatedAt: Date.now(),
        error: null,
        ...snapshot,
      };
    } catch (error) {
      this.status = {
        ...this.status,
        connected: false,
        error:
          error instanceof Error ? error.message : 'Account refresh failed',
      };
      logger.warn('Binance read-only account refresh failed');
    }
  }

  private scheduleImmediateRefresh(): void {
    if (this.refreshDebounceTimer) clearTimeout(this.refreshDebounceTimer);
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = null;
      void this.refresh();
    }, 150);
  }

  private async connectStream(): Promise<void> {
    if (this.stopping || this.socket || !this.status.configured) return;
    const stored = this.credentials.load();
    if (!stored) return;
    this.status = {
      ...this.status,
      stream: streamStatus({
        ...this.status.stream,
        status: 'CONNECTING',
        error: null,
      }),
    };
    try {
      const client = this.createClient(stored);
      const listenKey = await client.startUserDataStream();
      this.listenKeyActive = true;
      if (this.stopping) {
        await client.closeUserDataStream().catch(() => undefined);
        this.listenKeyActive = false;
        return;
      }
      const socket = new NodeWebSocket(buildUserDataStreamUrl(listenKey));
      this.socket = socket;
      socket.on('open', () => {
        if (this.socket !== socket) return;
        this.reconnectAttempts = 0;
        this.status = {
          ...this.status,
          stream: streamStatus({
            ...this.status.stream,
            status: 'CONNECTED',
            error: null,
          }),
        };
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = setInterval(() => {
          void client.keepAliveUserDataStream().catch(() => {
            this.status = {
              ...this.status,
              stream: streamStatus({
                ...this.status.stream,
                status: 'DISCONNECTED',
                error: 'USER_STREAM_KEEPALIVE_FAILED',
              }),
            };
            socket.close();
          });
        }, STREAM_KEEPALIVE_MS);
        logger.info('Binance read-only account stream connected');
      });
      socket.on('message', (data) => {
        const message = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString('utf8')
            : data.toString('utf8');
        this.handleStreamMessage(message);
      });
      socket.on('error', () => {
        this.status = {
          ...this.status,
          stream: streamStatus({
            ...this.status.stream,
            error: 'USER_STREAM_SOCKET_ERROR',
          }),
        };
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
        this.listenKeyActive = false;
        this.status = {
          ...this.status,
          stream: streamStatus({
            ...this.status.stream,
            status: 'DISCONNECTED',
          }),
        };
        if (!this.stopping) this.scheduleReconnect();
      });
    } catch (error) {
      this.status = {
        ...this.status,
        stream: streamStatus({
          ...this.status.stream,
          status: 'DISCONNECTED',
          error:
            error instanceof Error
              ? error.message
              : 'USER_STREAM_CONNECTION_FAILED',
        }),
      };
      this.scheduleReconnect();
    }
  }

  private handleStreamMessage(raw: string): void {
    try {
      const event = JSON.parse(raw) as { e?: unknown; E?: unknown };
      if (typeof event.e !== 'string') return;
      const now = Date.now();
      const eventTime = typeof event.E === 'number' ? event.E : now;
      const next = streamStatus({
        ...this.status.stream,
        status: 'CONNECTED',
        lastEventAt: eventTime,
        error: null,
      });
      if (event.e === 'ACCOUNT_UPDATE') next.lastAccountUpdateAt = eventTime;
      if (event.e === 'ORDER_TRADE_UPDATE')
        next.lastOrderTradeUpdateAt = eventTime;
      this.status = { ...this.status, stream: next };
      if (shouldRefreshAccountForEvent(event.e))
        this.scheduleImmediateRefresh();
      if (event.e === 'listenKeyExpired') this.socket?.close();
    } catch {
      this.status = {
        ...this.status,
        stream: streamStatus({
          ...this.status.stream,
          error: 'USER_STREAM_EVENT_INVALID',
        }),
      };
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const base = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts += 1;
    this.status = {
      ...this.status,
      stream: streamStatus({
        ...this.status.stream,
        reconnectCount: this.status.stream.reconnectCount + 1,
      }),
    };
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectStream();
    }, delay);
  }

  private async closeListenKey(): Promise<void> {
    if (!this.listenKeyActive) return;
    this.listenKeyActive = false;
    const stored = this.credentials.load();
    if (!stored) return;
    try {
      await this.createClient(stored).closeUserDataStream();
    } catch {
      // The key may already be expired or the application may be shutting down.
    }
  }
}
