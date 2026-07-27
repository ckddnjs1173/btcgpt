import { describe, it, expect, vi } from 'vitest';
import { generateSnapshot } from '../../src/main/market/snapshot';

vi.mock('../../src/main/binance/public/rest', () => ({
  fetchServerTime: () => ({ serverTime: 1680000000000 }),
  fetchKlines: () => [
    [1680000000000, '30000', '30100', '29900', '30050', '12.3', 1680000059999],
  ],
}));

vi.mock('../../src/main/binance/public/additional', () => ({
  fetchPremiumIndex: () => ({
    symbol: 'BTCUSDT',
    markPrice: '30050',
    indexPrice: '30045',
    lastFundingRate: '0.0001',
    nextFundingTime: 1680003600000,
  }),
  fetchOpenInterest: () => ({ symbol: 'BTCUSDT', openInterest: '123.45', time: 1680000000000 }),
}));

describe('snapshot generator', () => {
  it('builds a minimal snapshot', async () => {
    const snap = await generateSnapshot();

    expect(snap.symbol).toBe('BTCUSDT');
    expect(snap.timeframes['5m'].closed).toHaveLength(1);
    expect(snap.marketState.markPrice).toBe('30050');
  });
});
