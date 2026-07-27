import { describe, it, expect } from 'vitest';
import { klinesSchema, klineTuple } from '../../src/main/binance/schemas';

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
    ];

    const parsed = klineTuple.parse(sample);

    expect(parsed[0]).toBe(1680000000000);
    expect(parsed[4]).toBe('30050.00');
  });

  it('parses klines array', () => {
    const arr = [
      [1680000000000, '30000.00', '30100.00', '29900.00', '30050.00', '12.34', 1680000059999],
    ];

    const parsed = klinesSchema.parse(arr);

    expect(parsed).toHaveLength(1);
  });
});
