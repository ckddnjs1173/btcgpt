import { describe, expect, it } from 'vitest';

import {
  buildDeribitOptionsIntelligenceV2,
  type DeribitInstrumentRow,
  type DeribitSummaryRow,
} from '../../src/main/external/options-v2';

const DAY_MS = 24 * 60 * 60_000;

function option(
  now: number,
  days: number,
  strike: number,
  type: 'call' | 'put',
  iv: number,
  oi: number,
  volume: number,
): { instrument: DeribitInstrumentRow; summary: DeribitSummaryRow } {
  const expiration = now + days * DAY_MS;
  const suffix = type === 'call' ? 'C' : 'P';
  const name = `BTC-${days}D-${strike}-${suffix}`;
  return {
    instrument: {
      instrument_name: name,
      kind: 'option',
      expiration_timestamp: expiration,
      strike,
      option_type: type,
      is_active: true,
    },
    summary: {
      instrument_name: name,
      open_interest: oi,
      volume,
      mark_iv: iv,
      underlying_price: 100_000,
      interest_rate: 0,
    },
  };
}

describe('Deribit Options V2', () => {
  it('builds objective DVOL, term, skew, put/call and OI structure', () => {
    const now = Date.UTC(2026, 7, 17, 0, 0, 0);
    const rows = [
      option(now, 7, 95_000, 'put', 58, 20, 8),
      option(now, 7, 100_000, 'put', 55, 12, 4),
      option(now, 7, 100_000, 'call', 53, 15, 7),
      option(now, 7, 105_000, 'call', 50, 18, 9),
      option(now, 30, 90_000, 'put', 62, 30, 10),
      option(now, 30, 100_000, 'put', 57, 22, 6),
      option(now, 30, 100_000, 'call', 55, 25, 11),
      option(now, 30, 110_000, 'call', 51, 28, 12),
    ];
    const result = buildDeribitOptionsIntelligenceV2({
      now,
      instruments: rows.map((row) => row.instrument),
      summaries: rows.map((row) => row.summary),
      dvol: { value: 54.2, observedAt: now - 30_000 },
    });

    expect(result.version).toBe('deribit-options-v2');
    expect(result.objectiveOnly).toBe(true);
    expect(result.dvol?.value).toBe(54.2);
    expect(result.atmIv.sevenDay?.strike).toBe(100_000);
    expect(result.atmIv.sevenDay?.markIv).toBe(54);
    expect(result.atmIv.thirtyDay?.markIv).toBe(56);
    expect(result.termStructure.sevenDayMinusThirtyDayIv).toBe(-2);
    expect(result.skew25Delta.sevenDay?.putMinusCallIv).toBeGreaterThan(0);
    expect(result.putCall.openInterestBtc).toBe(170);
    expect(result.putCall.putCallOpenInterestRatio).toBeCloseTo(84 / 86);
    expect(result.oiByExpiry).toHaveLength(2);
    expect(result.nearbyLargestOiStrikes[0]?.strike).toBe(100_000);
    expect(result.provenance.map((row) => row.metricNature)).toContain(
      'DERIVED',
    );
    expect(result).not.toHaveProperty('signal');
    expect(result).not.toHaveProperty('recommendedSide');
    expect(JSON.stringify(result)).not.toMatch(
      /longSignal|shortSignal|buySignal|sellSignal|bullishScore|bearishScore/i,
    );
  });

  it('returns null IV structures when the source lacks usable IV instead of inventing values', () => {
    const now = Date.UTC(2026, 7, 17, 0, 0, 0);
    const row = option(now, 7, 100_000, 'call', 50, 1, 1);
    const result = buildDeribitOptionsIntelligenceV2({
      now,
      instruments: [row.instrument],
      summaries: [{ ...row.summary, mark_iv: null }],
      dvol: null,
    });
    expect(result.atmIv.sevenDay).toBeNull();
    expect(result.skew25Delta.sevenDay).toBeNull();
    expect(result.dvol).toBeNull();
  });
});
