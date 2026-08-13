import { describe, expect, it, vi } from 'vitest';

import { BinanceAccountClient } from '../../src/main/binance/account/rest';

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

  it('rejects crossed margin even when leverage is in range', async () => {
    const { client } = clientWithResponses(20, 'CROSSED');
    await expect(client.fetchPosition()).rejects.toThrow(/isolated margin/);
  });

  it('rejects leverage outside the supported 1-150 range', async () => {
    const { client } = clientWithResponses(151);
    await expect(client.fetchPosition()).rejects.toThrow(/1-150 range/);
  });
});
