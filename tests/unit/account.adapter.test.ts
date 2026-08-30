import { describe, expect, it, vi } from 'vitest';

import { BinanceAccountClient } from '../../src/main/binance/account/rest';
import {
  ACCOUNT_STREAM_EVENTS,
  buildUserDataStreamUrl,
  shouldRefreshAccountForEvent,
} from '../../src/main/binance/account/service';

function positionResponse() {
  return new Response(
    JSON.stringify([
      {
        symbol: 'BTCUSDT',
        positionSide: 'BOTH',
        positionAmt: '0.010',
        entryPrice: '60000',
        breakEvenPrice: '60020',
        markPrice: '61000',
        unRealizedProfit: '10',
        liquidationPrice: '54000',
        isolatedMargin: '60',
        updateTime: 1_700_000_000_000,
      },
    ]),
  );
}

function symbolConfigurationResponse(leverage = 10, marginType = 'ISOLATED') {
  return new Response(
    JSON.stringify([
      {
        symbol: 'BTCUSDT',
        leverage,
        marginType,
      },
    ]),
  );
}

function clientWithResponses(leverage: number, marginType = 'ISOLATED') {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(positionResponse())
    .mockResolvedValueOnce(symbolConfigurationResponse(leverage, marginType));
  return {
    fetcher,
    client: new BinanceAccountClient(
      { apiKey: 'test-key', apiSecret: 'test-secret' },
      fetcher,
    ),
  };
}

describe('read-only account adapter', () => {
  it('normalizes a user-selected isolated BTCUSDT position with signed GET', async () => {
    const { client, fetcher } = clientWithResponses(50);

    const position = await client.fetchPosition();

    expect(position?.side).toBe('LONG');
    expect(position?.leverage).toBe(50);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [positionUrl, positionOptions] = fetcher.mock.calls[0] as [
      string,
      RequestInit,
    ];
    const [configurationUrl] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(positionUrl).toContain('/fapi/v3/positionRisk?symbol=BTCUSDT');
    expect(configurationUrl).toContain('/fapi/v1/symbolConfig?symbol=BTCUSDT');
    expect(positionUrl).toContain('signature=');
    expect(positionOptions.method).toBe('GET');
  });

  it('reads normal and Algo Service protective orders through signed GET only', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              symbol: 'BTCUSDT',
              side: 'SELL',
              type: 'LIMIT',
              price: '62000',
              stopPrice: '0',
              origQty: '0.004',
              reduceOnly: true,
              closePosition: false,
              updateTime: 1_700_000_000_100,
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              algoId: 123,
              algoType: 'CONDITIONAL',
              symbol: 'BTCUSDT',
              side: 'SELL',
              orderType: 'STOP_MARKET',
              triggerPrice: '59000',
              quantity: '0',
              reduceOnly: false,
              closePosition: true,
              createTime: 1_700_000_000_000,
              updateTime: 1_700_000_000_200,
            },
          ]),
        ),
      );
    const client = new BinanceAccountClient(
      { apiKey: 'test-key', apiSecret: 'test-secret' },
      fetcher,
    );

    const orders = await client.fetchOpenOrders();

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [regularUrl, regularInit] = fetcher.mock.calls[0] as [
      string,
      RequestInit,
    ];
    const [algoUrl, algoInit] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(regularUrl).toContain('/fapi/v1/openOrders?symbol=BTCUSDT');
    expect(algoUrl).toContain('/fapi/v1/openAlgoOrders?algoType=CONDITIONAL');
    expect(algoUrl).toContain('symbol=BTCUSDT');
    expect(regularInit.method).toBe('GET');
    expect(algoInit.method).toBe('GET');
    expect(orders).toEqual([
      expect.objectContaining({
        type: 'LIMIT',
        quantity: 0.004,
        reduceOnly: true,
        protective: true,
      }),
      expect.objectContaining({
        type: 'STOP_MARKET',
        stopPrice: 59000,
        closePosition: true,
        protective: true,
      }),
    ]);
  });

  it('rejects crossed margin even when leverage is in range', async () => {
    const { client } = clientWithResponses(20, 'CROSSED');
    await expect(client.fetchPosition()).rejects.toThrow(/isolated margin/);
  });

  it('rejects leverage outside the supported 1-150 range', async () => {
    const { client } = clientWithResponses(151);
    await expect(client.fetchPosition()).rejects.toThrow(/1-150 range/);
  });
});

describe('Binance private user stream contract', () => {
  it('uses the routed private endpoint with explicit account and algo events', () => {
    const url = buildUserDataStreamUrl('listen/key+value');

    expect(url).toBe(
      'wss://fstream.binance.com/private/ws?listenKey=listen%2Fkey%2Bvalue&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE/ACCOUNT_CONFIG_UPDATE/ALGO_UPDATE',
    );
    expect(ACCOUNT_STREAM_EVENTS).toContain('ALGO_UPDATE');
    expect(url).not.toContain('wss://fstream.binance.com/ws/');
  });

  it('refreshes the read-only snapshot for Algo Service updates', () => {
    expect(shouldRefreshAccountForEvent('ACCOUNT_UPDATE')).toBe(true);
    expect(shouldRefreshAccountForEvent('ORDER_TRADE_UPDATE')).toBe(true);
    expect(shouldRefreshAccountForEvent('ACCOUNT_CONFIG_UPDATE')).toBe(true);
    expect(shouldRefreshAccountForEvent('ALGO_UPDATE')).toBe(true);
    expect(shouldRefreshAccountForEvent('listenKeyExpired')).toBe(false);
  });
});
