import { describe, it, expect } from 'vitest';
import { fetchAccountPosition } from '../../src/main/binance/account/rest';

describe('account adapter stub', () => {
  it('throws not implemented error', () => {
    expect(() => fetchAccountPosition()).toThrow(/not implemented/);
  });
});
