import { describe, it, expect } from 'vitest';
import { rsi } from '../../src/shared/calculations/rsi';

describe('RSI calculation', () => {
  it('returns null when insufficient data', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });

  it('computes RSI for a simple upward series', () => {
    const vals = Array.from({ length: 30 }, (_, i) => i + 1);
    const val = rsi(vals, 14);
    expect(typeof val).toBe('number');
    expect(val! > 50).toBe(true);
  });
});
