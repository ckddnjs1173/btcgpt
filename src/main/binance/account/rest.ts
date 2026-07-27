import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { numericStringSchema } from '../schemas';

const BASE_URL = 'https://fapi.binance.com';
const ALLOWED_PATHS = new Set([
  '/fapi/v2/positionRisk',
  '/fapi/v1/commissionRate',
  '/fapi/v1/openOrders',
  '/fapi/v1/userTrades',
  '/fapi/v2/balance',
]);

const positionSchema = z.array(
  z.object({
    symbol: z.literal('BTCUSDT'),
    positionAmt: numericStringSchema,
    entryPrice: numericStringSchema,
    breakEvenPrice: numericStringSchema.optional(),
    markPrice: numericStringSchema,
    unRealizedProfit: numericStringSchema,
    liquidationPrice: numericStringSchema,
    leverage: numericStringSchema,
    marginType: z.string(),
    isolatedMargin: numericStringSchema,
    updateTime: z.number(),
  }),
);

const commissionSchema = z.object({
  symbol: z.literal('BTCUSDT'),
  makerCommissionRate: numericStringSchema,
  takerCommissionRate: numericStringSchema,
});
const balanceSchema = z.array(
  z.object({
    asset: z.string(),
    balance: numericStringSchema,
    availableBalance: numericStringSchema,
    crossWalletBalance: numericStringSchema,
    updateTime: z.number(),
  }),
);
const openOrderSchema = z.array(
  z.object({
    symbol: z.literal('BTCUSDT'),
    side: z.enum(['BUY', 'SELL']),
    type: z.string(),
    price: numericStringSchema,
    stopPrice: numericStringSchema,
    origQty: numericStringSchema,
    reduceOnly: z.boolean(),
    closePosition: z.boolean(),
    updateTime: z.number(),
  }),
);

export interface AccountCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface AccountPosition {
  source: 'BINANCE_READ_ONLY';
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  breakEvenPrice: number | null;
  markPrice: number;
  unrealizedPnl: number;
  isolatedMargin: number;
  liquidationPrice: number | null;
  leverage: 10;
  marginMode: 'ISOLATED';
  updatedAt: number;
}

export class BinanceAccountClient {
  constructor(
    private readonly credentials: AccountCredentials,
    private readonly fetcher: typeof fetch = fetch,
    private readonly serverOffsetMs = 0,
  ) {}

  private async signedGet(
    path: string,
    parameters: Record<string, string> = {},
  ) {
    if (!ALLOWED_PATHS.has(path))
      throw new Error('Account endpoint is not in the signed GET allowlist');
    const query = new URLSearchParams({
      ...parameters,
      timestamp: String(Date.now() + this.serverOffsetMs),
      recvWindow: '5000',
    });
    const signature = createHmac('sha256', this.credentials.apiSecret)
      .update(query.toString())
      .digest('hex');
    query.set('signature', signature);
    const response = await this.fetcher(`${BASE_URL}${path}?${query}`, {
      method: 'GET',
      headers: { 'X-MBX-APIKEY': this.credentials.apiKey },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok)
      throw new Error(`Binance account API returned HTTP ${response.status}`);
    return (await response.json()) as unknown;
  }

  async fetchPosition(): Promise<AccountPosition | null> {
    const raw = positionSchema.parse(
      await this.signedGet('/fapi/v2/positionRisk', { symbol: 'BTCUSDT' }),
    );
    const item = raw.find((position) => position.symbol === 'BTCUSDT');
    if (!item || Number(item.positionAmt) === 0) return null;
    if (
      Number(item.leverage) !== 10 ||
      item.marginType.toLowerCase() !== 'isolated'
    )
      throw new Error('Account position violates fixed 10x isolated policy');
    const amount = Number(item.positionAmt);
    return {
      source: 'BINANCE_READ_ONLY',
      side: amount > 0 ? 'LONG' : 'SHORT',
      quantity: Math.abs(amount),
      entryPrice: Number(item.entryPrice),
      breakEvenPrice: item.breakEvenPrice ? Number(item.breakEvenPrice) : null,
      markPrice: Number(item.markPrice),
      unrealizedPnl: Number(item.unRealizedProfit),
      isolatedMargin: Number(item.isolatedMargin),
      liquidationPrice:
        Number(item.liquidationPrice) > 0
          ? Number(item.liquidationPrice)
          : null,
      leverage: 10,
      marginMode: 'ISOLATED',
      updatedAt: item.updateTime,
    };
  }

  async fetchCommission() {
    const item = commissionSchema.parse(
      await this.signedGet('/fapi/v1/commissionRate', { symbol: 'BTCUSDT' }),
    );
    return {
      makerRate: Number(item.makerCommissionRate),
      takerRate: Number(item.takerCommissionRate),
      updatedAt: Date.now(),
    };
  }

  async fetchAvailableBalance() {
    const balances = balanceSchema.parse(
      await this.signedGet('/fapi/v2/balance'),
    );
    const usdt = balances.find((item) => item.asset === 'USDT');
    return {
      availableBalance: usdt ? Number(usdt.availableBalance) : null,
      walletBalance: usdt ? Number(usdt.balance) : null,
      updatedAt: usdt?.updateTime ?? Date.now(),
    };
  }

  async fetchOpenOrders() {
    const orders = openOrderSchema.parse(
      await this.signedGet('/fapi/v1/openOrders', { symbol: 'BTCUSDT' }),
    );
    return orders
      .filter((order) => order.symbol === 'BTCUSDT')
      .map((order) => ({
        side: order.side,
        type: order.type,
        price: Number(order.price),
        stopPrice: Number(order.stopPrice),
        quantity: Number(order.origQty),
        reduceOnly: order.reduceOnly,
        closePosition: order.closePosition,
        protective:
          order.reduceOnly ||
          order.closePosition ||
          ['STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET'].includes(
            order.type,
          ),
        updatedAt: order.updateTime,
      }));
  }
}
