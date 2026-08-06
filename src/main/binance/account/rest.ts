import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { numericStringSchema } from '../schemas';

const BASE_URL = 'https://fapi.binance.com';
const ALLOWED_PATHS = new Set([
  '/fapi/v3/positionRisk',
  '/fapi/v3/balance',
  '/fapi/v1/symbolConfig',
  '/fapi/v1/commissionRate',
  '/fapi/v1/openOrders',
  '/fapi/v1/leverageBracket',
  '/fapi/v1/userTrades',
]);

const positionSchema = z.array(
  z.object({
    symbol: z.literal('BTCUSDT'),
    positionSide: z.enum(['BOTH', 'LONG', 'SHORT']),
    positionAmt: numericStringSchema,
    entryPrice: numericStringSchema,
    breakEvenPrice: numericStringSchema.optional(),
    markPrice: numericStringSchema,
    unRealizedProfit: numericStringSchema,
    liquidationPrice: numericStringSchema,
    isolatedMargin: numericStringSchema,
    updateTime: z.number(),
  }),
);

const symbolConfigurationSchema = z.array(
  z.object({
    symbol: z.literal('BTCUSDT'),
    marginType: z.string(),
    leverage: z.number().int().positive(),
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
const leverageBracketSchema = z.array(
  z.object({
    symbol: z.literal('BTCUSDT'),
    brackets: z.array(
      z.object({
        bracket: z.number().int().positive(),
        initialLeverage: z.number().int().positive(),
        notionalCap: z.number().nonnegative(),
        notionalFloor: z.number().nonnegative(),
        maintMarginRatio: z.number().nonnegative(),
      }),
    ),
  }),
);
const listenKeySchema = z.object({ listenKey: z.string().min(1) });

const userTradesSchema = z.array(
  z.object({
    symbol: z.literal('BTCUSDT'),
    side: z.enum(['BUY', 'SELL']),
    positionSide: z.enum(['BOTH', 'LONG', 'SHORT']),
    price: numericStringSchema,
    qty: numericStringSchema,
    realizedPnl: numericStringSchema,
    commission: numericStringSchema,
    commissionAsset: z.string(),
    maker: z.boolean(),
    id: z.number().int().nonnegative(),
    orderId: z.number().int().nonnegative(),
    time: z.number(),
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
  leverage: number;
  marginMode: 'ISOLATED';
  updatedAt: number;
}

export class BinanceAccountClient {
  constructor(
    private readonly credentials: AccountCredentials,
    private readonly fetcher: typeof fetch = fetch,
    private readonly serverOffsetMs = 0,
  ) {}

  private async keyRequest(
    method: 'POST' | 'PUT' | 'DELETE',
    path: '/fapi/v1/listenKey',
  ): Promise<unknown> {
    const response = await this.fetcher(`${BASE_URL}${path}`, {
      method,
      headers: { 'X-MBX-APIKEY': this.credentials.apiKey },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok)
      throw new Error(`Binance user stream API returned HTTP ${response.status}`);
    return (await response.json()) as unknown;
  }

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

  async startUserDataStream(): Promise<string> {
    return listenKeySchema.parse(
      await this.keyRequest('POST', '/fapi/v1/listenKey'),
    ).listenKey;
  }

  async keepAliveUserDataStream(): Promise<void> {
    await this.keyRequest('PUT', '/fapi/v1/listenKey');
  }

  async closeUserDataStream(): Promise<void> {
    await this.keyRequest('DELETE', '/fapi/v1/listenKey');
  }

  async fetchPosition(): Promise<AccountPosition | null> {
    const [positions, configurations] = await Promise.all([
      this.signedGet('/fapi/v3/positionRisk', { symbol: 'BTCUSDT' }),
      this.signedGet('/fapi/v1/symbolConfig', { symbol: 'BTCUSDT' }),
    ]);
    const raw = positionSchema.parse(positions);
    const configuration = symbolConfigurationSchema
      .parse(configurations)
      .find((item) => item.symbol === 'BTCUSDT');
    if (!configuration)
      throw new Error('BTCUSDT account configuration was not returned');
    if (configuration.marginType.toLowerCase() !== 'isolated')
      throw new Error('BTCUSDT must be configured as isolated margin');
    if (configuration.leverage < 1 || configuration.leverage > 150)
      throw new Error('BTCUSDT leverage is outside the supported 1-150 range');
    const activePositions = raw.filter(
      (position) =>
        position.symbol === 'BTCUSDT' && Number(position.positionAmt) !== 0,
    );
    if (activePositions.length === 0) return null;
    if (activePositions.length > 1)
      throw new Error('Multiple active BTCUSDT position legs are not supported');
    const item = activePositions[0]!;
    const amount = Number(item.positionAmt);
    const side =
      item.positionSide === 'LONG' || item.positionSide === 'SHORT'
        ? item.positionSide
        : amount > 0
          ? 'LONG'
          : 'SHORT';
    return {
      source: 'BINANCE_READ_ONLY',
      side,
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
      leverage: configuration.leverage,
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
      await this.signedGet('/fapi/v3/balance'),
    );
    const usdt = balances.find((item) => item.asset === 'USDT');
    return {
      availableBalance: usdt ? Number(usdt.availableBalance) : null,
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

  async fetchLeverageBrackets() {
    const result = leverageBracketSchema.parse(
      await this.signedGet('/fapi/v1/leverageBracket', {
        symbol: 'BTCUSDT',
      }),
    );
    const now = Date.now();
    return (
      result.find((item) => item.symbol === 'BTCUSDT')?.brackets ?? []
    ).map((item) => ({
      bracket: item.bracket,
      initialLeverage: item.initialLeverage,
      notionalFloor: item.notionalFloor,
      notionalCap: item.notionalCap,
      maintenanceMarginRate: item.maintMarginRatio,
      updatedAt: now,
    }));
  }

  async fetchRecentTrades() {
    const trades = userTradesSchema.parse(
      await this.signedGet('/fapi/v1/userTrades', {
        symbol: 'BTCUSDT',
        limit: '50',
      }),
    );
    return trades.map((trade) => ({
      tradeId: String(trade.id),
      orderId: String(trade.orderId),
      side: trade.side,
      positionSide: trade.positionSide,
      price: Number(trade.price),
      quantity: Number(trade.qty),
      realizedPnl: Number(trade.realizedPnl),
      commission: Number(trade.commission),
      commissionAsset: trade.commissionAsset,
      maker: trade.maker,
      timestamp: trade.time,
    }));
  }
}
