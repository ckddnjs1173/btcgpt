import { describe, it, expect } from 'vitest';
import {
  exchangeInfoSchema,
  klinesSchema,
  klineTuple,
  numericStringSchema,
} from '../../src/main/binance/schemas';

describe('Binance schemas', () => {
  it('parses a sample kline tuple', () => {
    const sample = [
      1680000000000,
      '30000.00',
      '30100.00',
      '29900.00',
      '30050.00',
      '12.34',
      1680000059999,
      '370000',
      42,
      '6.12',
      '184000',
      '0',
    ];

    const parsed = klineTuple.parse(sample);

    expect(parsed[0]).toBe(1680000000000);
    expect(parsed[4]).toBe('30050.00');
  });

  it('parses klines array', () => {
    const arr = [
      [
        1680000000000,
        '30000.00',
        '30100.00',
        '29900.00',
        '30050.00',
        '12.34',
        1680000059999,
        '370000',
        42,
        '6.12',
        '184000',
        '0',
      ],
    ];

    const parsed = klinesSchema.parse(arr);

    expect(parsed).toHaveLength(1);
  });

  it('rejects non-decimal numeric strings', () => {
    expect(() => numericStringSchema.parse('NaN')).toThrow();
    expect(() => numericStringSchema.parse('1e4')).toThrow();
  });

  it('parses required exchange filters without accepting raw use', () => {
    const parsed = exchangeInfoSchema.parse({
      serverTime: 1,
      symbols: [
        {
          symbol: 'BTCUSDT',
          contractType: 'PERPETUAL',
          status: 'TRADING',
          filters: [
            { filterType: 'PRICE_FILTER', tickSize: '0.10' },
            {
              filterType: 'LOT_SIZE',
              minQty: '0.001',
              stepSize: '0.001',
            },
            { filterType: 'MIN_NOTIONAL', notional: '5' },
          ],
        },
      ],
    });
    expect(parsed.symbols[0]?.symbol).toBe('BTCUSDT');
  });
});
