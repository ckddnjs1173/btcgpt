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

describe('read-only account adapter', () => {
  it('normalizes a fixed 10x isolated BTCUSDT position with signed GET', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(positionResponse())
      .mockResolvedValueOnce(symbolConfigurationResponse());
    const client = new BinanceAccountClient(
      { apiKey: 'a'.repeat(32), apiSecret: 'b'.repeat(32) },
      fetcher,
    );

    const position = await client.fetchPosition();

    expect(position?.side).toBe('LONG');
    expect(position?.leverage).toBe(10);
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

  it('rejects account symbol configuration outside the fixed policy', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(positionResponse())
      .mockResolvedValueOnce(symbolConfigurationResponse(20, 'CROSSED'));
    const client = new BinanceAccountClient(
      { apiKey: 'a'.repeat(32), apiSecret: 'b'.repeat(32) },
      fetcher,
    );

    await expect(client.fetchPosition()).rejects.toThrow(/10x isolated/);
  });
});
