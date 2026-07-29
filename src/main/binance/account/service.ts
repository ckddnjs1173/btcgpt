import type {
  AccountConfigurationInput,
  AccountStatus,
} from '../../../shared/contracts';
import { logger } from '../../logging/logger';
import type { CredentialStore } from '../../security/credential-store';
import { BinanceAccountClient } from './rest';

export class AccountService {
  private status: AccountStatus;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly credentials: CredentialStore,
    private readonly getServerOffsetMs: () => number = () => 0,
  ) {
    this.status = {
      configured: credentials.hasCredentials(),
      connected: false,
      lastUpdatedAt: null,
      error: null,
      position: null,
      commission: null,
      balance: null,
      openOrders: [],
      recentTrades: [],
      leverageBrackets: [],
    };
  }

  start(): void {
    if (!this.status.configured || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async configure(input: AccountConfigurationInput): Promise<void> {
    const offset = this.getServerOffsetMs();
    if (Math.abs(offset) > 10_000)
      throw new Error('System clock differs too much from Binance server time');
    const client = new BinanceAccountClient(input, fetch, offset);
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
    this.credentials.save(input);
    this.status = {
      configured: true,
      connected: true,
      lastUpdatedAt: Date.now(),
      error: null,
      position,
      commission,
      balance,
      openOrders,
      recentTrades,
      leverageBrackets,
    };
    if (!this.timer)
      this.timer = setInterval(() => void this.refresh(), 30_000);
  }

  disconnect(): void {
    this.stop();
    this.credentials.clear();
    this.status = {
      configured: false,
      connected: false,
      lastUpdatedAt: null,
      error: null,
      position: null,
      commission: null,
      balance: null,
      openOrders: [],
      recentTrades: [],
      leverageBrackets: [],
    };
  }

  getStatus(): AccountStatus {
    return structuredClone(this.status);
  }

  private async refresh(): Promise<void> {
    const stored = this.credentials.load();
    if (!stored) return;
    try {
      const offset = this.getServerOffsetMs();
      if (Math.abs(offset) > 10_000)
        throw new Error(
          'System clock differs too much from Binance server time',
        );
      const client = new BinanceAccountClient(stored, fetch, offset);
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
      this.status = {
        configured: true,
        connected: true,
        lastUpdatedAt: Date.now(),
        error: null,
        position,
        commission,
        balance,
        openOrders,
        recentTrades,
        leverageBrackets,
      };
    } catch (error) {
      this.status = {
        ...this.status,
        connected: false,
        error:
          error instanceof Error ? error.message : 'Account refresh failed',
        position: null,
        commission: null,
        balance: null,
        openOrders: [],
        recentTrades: [],
        leverageBrackets: [],
      };
      logger.warn('Binance read-only account refresh failed');
    }
  }
}
