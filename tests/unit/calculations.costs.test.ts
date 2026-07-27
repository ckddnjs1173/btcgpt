import { describe, it, expect } from 'vitest';
import { notionalEntry, grossPnlLong, fee, netPnl } from '../../src/shared/calculations/costs';

describe('cost calculations', () => {
  it('computes notional and fees', () => {
    const n = notionalEntry(0.1, 30000);
    expect(n).toBeCloseTo(3000);
    const gross = grossPnlLong(0.1, 30000, 30500);
    expect(gross).toBeCloseTo(50);
    const f = fee(n, 0.0005);
    expect(typeof f).toBe('number');
    const net = netPnl(gross, f, f, 0.1, 0);
    expect(typeof net).toBe('number');
  });
});
