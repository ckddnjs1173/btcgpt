import { describe, it, expect } from 'vitest';
import { ema } from '../../src/shared/calculations/ema';

describe('EMA calculation', () => {
  it('returns null for insufficient data', () => {
    expect(ema([1, 2, 3], 5)).toBeNull();
  });

  it('computes EMA for simple series', () => {
    const vals = [1, 2, 3, 4, 5, 6, 7];
    const result = ema(vals, 3);
    expect(typeof result).toBe('number');
  });
});
