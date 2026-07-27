import { describe, expect, it, vi } from 'vitest';

import { BinanceAccountClient } from '../../src/main/binance/account/rest';

describe('read-only account adapter', () => {
  it('normalizes a fixed 10x isolated BTCUSDT position with signed GET', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            symbol: 'BTCUSDT',
            positionAmt: '0.010',
            entryPrice: '60000',
            breakEvenPrice: '60020',
            markPrice: '61000',
            unRealizedProfit: '10',
            liquidationPrice: '54000',
            leverage: '10',
            marginType: 'isolated',
            isolatedMargin: '60',
            updateTime: 1_700_000_000_000,
          },
        ]),
      ),
    );
    const client = new BinanceAccountClient(
      { apiKey: 'a'.repeat(32), apiSecret: 'b'.repeat(32) },
      fetcher,
    );
    const position = await client.fetchPosition();
    expect(position?.side).toBe('LONG');
    expect(position?.leverage).toBe(10);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/fapi/v2/positionRisk?symbol=BTCUSDT');
    expect(url).toContain('signature=');
    expect(options.method).toBe('GET');
  });

  it('rejects positions outside the fixed policy', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            symbol: 'BTCUSDT',
            positionAmt: '0.01',
            entryPrice: '1',
            markPrice: '1',
            unRealizedProfit: '0',
            liquidationPrice: '0',
            leverage: '20',
            marginType: 'cross',
            isolatedMargin: '0',
            updateTime: 1,
          },
        ]),
      ),
    );
    const client = new BinanceAccountClient(
      { apiKey: 'a'.repeat(32), apiSecret: 'b'.repeat(32) },
      fetcher,
    );
    await expect(client.fetchPosition()).rejects.toThrow(/10x isolated/);
  });
});
