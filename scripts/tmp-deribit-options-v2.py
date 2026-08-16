from pathlib import Path
import json

ROOT = Path('.')


def write(path: str, content: str) -> None:
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding='utf-8', newline='\n')


def replace_once(path: str, old: str, new: str) -> None:
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'anchor missing in {path}: {old[:120]!r}')
    text = text.replace(old, new, 1)
    p.write_text(text, encoding='utf-8', newline='\n')


write('src/shared/options-intelligence.ts', r'''import { z } from 'zod';

import { dataProvenanceSchema } from './market-intelligence';

export const DERIBIT_OPTIONS_VERSION = 'deribit-options-v2' as const;

const finite = z.number().finite();
const positive = z.number().positive();
const epochMs = z.number().int().nonnegative();
const nullableFinite = finite.nullable();

export const optionsIvPointSchema = z
  .object({
    expirationAt: epochMs,
    daysToExpiry: z.number().nonnegative(),
    strike: positive,
    markIv: z.number().nonnegative(),
  })
  .strict();

export const optionsSkewPointSchema = z
  .object({
    expirationAt: epochMs,
    daysToExpiry: z.number().nonnegative(),
    putStrike: positive,
    putIv: z.number().nonnegative(),
    callStrike: positive,
    callIv: z.number().nonnegative(),
    putMinusCallIv: finite,
  })
  .strict();

const expiryOiSchema = z
  .object({
    expirationAt: epochMs,
    daysToExpiry: z.number().nonnegative(),
    openInterestBtc: z.number().nonnegative(),
    putOpenInterestBtc: z.number().nonnegative(),
    callOpenInterestBtc: z.number().nonnegative(),
    volume24hBtc: z.number().nonnegative(),
  })
  .strict();

const strikeOiSchema = z
  .object({
    strike: positive,
    distancePercent: finite,
    openInterestBtc: z.number().nonnegative(),
    putOpenInterestBtc: z.number().nonnegative(),
    callOpenInterestBtc: z.number().nonnegative(),
  })
  .strict();

export const deribitOptionsIntelligenceV2Schema = z
  .object({
    version: z.literal(DERIBIT_OPTIONS_VERSION),
    generatedAt: epochMs,
    objectiveOnly: z.literal(true),
    source: z.literal('DERIBIT'),
    underlying: z.literal('BTC'),
    underlyingPrice: positive.nullable(),
    dvol: z
      .object({
        value: z.number().nonnegative(),
        observedAt: epochMs,
      })
      .strict()
      .nullable(),
    atmIv: z
      .object({
        nearExpiry: optionsIvPointSchema.nullable(),
        sevenDay: optionsIvPointSchema.nullable(),
        thirtyDay: optionsIvPointSchema.nullable(),
      })
      .strict(),
    termStructure: z
      .object({
        nearMinusThirtyDayIv: nullableFinite,
        sevenDayMinusThirtyDayIv: nullableFinite,
      })
      .strict(),
    skew25Delta: z
      .object({
        sevenDay: optionsSkewPointSchema.nullable(),
        thirtyDay: optionsSkewPointSchema.nullable(),
      })
      .strict(),
    putCall: z
      .object({
        openInterestBtc: z.number().nonnegative(),
        putOpenInterestBtc: z.number().nonnegative(),
        callOpenInterestBtc: z.number().nonnegative(),
        putCallOpenInterestRatio: nullableFinite,
        volume24hBtc: z.number().nonnegative(),
        putVolume24hBtc: z.number().nonnegative(),
        callVolume24hBtc: z.number().nonnegative(),
        putCallVolumeRatio: nullableFinite,
      })
      .strict(),
    oiByExpiry: z.array(expiryOiSchema).max(24),
    nearbyLargestOiStrikes: z.array(strikeOiSchema).max(12),
    health: z
      .object({
        instrumentCount: z.number().int().nonnegative(),
        summaryCount: z.number().int().nonnegative(),
        validIvCount: z.number().int().nonnegative(),
        expirationCount: z.number().int().nonnegative(),
        ageMs: z.number().int().nonnegative(),
      })
      .strict(),
    provenance: z.array(dataProvenanceSchema).min(1).max(8),
  })
  .strict();

export type DeribitOptionsIntelligenceV2 = z.infer<
  typeof deribitOptionsIntelligenceV2Schema
>;
''')

write('src/main/external/options-v2.ts', r'''import { z } from 'zod';

import type { ExternalContextItem } from '../../shared/contracts';
import {
  DERIBIT_OPTIONS_VERSION,
  deribitOptionsIntelligenceV2Schema,
  type DeribitOptionsIntelligenceV2,
} from '../../shared/options-intelligence';
import type { DataProvenance } from '../../shared/market-intelligence';
import { item } from './adapters';

const DAY_MS = 24 * 60 * 60_000;
const YEAR_MS = 365 * DAY_MS;
const REQUEST_TIMEOUT_MS = 10_000;

const instrumentSchema = z
  .object({
    instrument_name: z.string(),
    kind: z.literal('option'),
    expiration_timestamp: z.number().int().positive(),
    strike: z.number().positive(),
    option_type: z.enum(['call', 'put']),
    is_active: z.boolean().optional(),
  })
  .passthrough();

const summarySchema = z
  .object({
    instrument_name: z.string(),
    open_interest: z.number().nonnegative().optional().nullable(),
    volume: z.number().nonnegative().optional().nullable(),
    mark_iv: z.number().nonnegative().optional().nullable(),
    underlying_price: z.number().positive().optional().nullable(),
    interest_rate: z.number().optional().nullable(),
  })
  .passthrough();

export type DeribitInstrumentRow = z.infer<typeof instrumentSchema>;
export type DeribitSummaryRow = z.infer<typeof summarySchema>;

interface JoinedOption {
  instrumentName: string;
  expirationAt: number;
  strike: number;
  optionType: 'call' | 'put';
  openInterest: number;
  volume24h: number;
  markIv: number | null;
  underlyingPrice: number | null;
  interestRate: number;
}

interface DvolPoint {
  value: number;
  observedAt: number;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`DERIBIT_HTTP_${response.status}`);
  return response.json() as Promise<unknown>;
}

function resultRows(raw: unknown): unknown[] {
  const root = z.object({ result: z.unknown() }).passthrough().parse(raw);
  return z.array(z.unknown()).parse(root.result);
}

function finite(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? value
    : null;
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  return left === undefined || right === undefined ? null : (left + right) / 2;
}

function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absolute = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * absolute);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf =
    sign *
    (1 -
      (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
        Math.exp(-absolute * absolute));
  return 0.5 * (1 + erf);
}

function optionDelta(row: JoinedOption, now: number): number | null {
  if (
    row.markIv === null ||
    row.markIv <= 0 ||
    row.underlyingPrice === null ||
    row.underlyingPrice <= 0 ||
    row.expirationAt <= now
  )
    return null;
  const t = (row.expirationAt - now) / YEAR_MS;
  const sigma = row.markIv / 100;
  if (t <= 0 || sigma <= 0) return null;
  const r = Math.abs(row.interestRate) > 1 ? row.interestRate / 100 : row.interestRate;
  const d1 =
    (Math.log(row.underlyingPrice / row.strike) +
      (r + (sigma * sigma) / 2) * t) /
    (sigma * Math.sqrt(t));
  const call = normalCdf(d1);
  return row.optionType === 'call' ? call : call - 1;
}

function closestExpiry(expiries: number[], now: number, days: number): number | null {
  const usable = expiries.filter((expiry) => expiry > now);
  if (!usable.length) return null;
  const target = now + days * DAY_MS;
  return [...usable].sort(
    (left, right) => Math.abs(left - target) - Math.abs(right - target),
  )[0] ?? null;
}

function ivPoint(
  rows: JoinedOption[],
  expirationAt: number | null,
  underlyingPrice: number | null,
  now: number,
): DeribitOptionsIntelligenceV2['atmIv']['nearExpiry'] {
  if (expirationAt === null || underlyingPrice === null) return null;
  const expiryRows = rows.filter(
    (row) => row.expirationAt === expirationAt && row.markIv !== null,
  );
  if (!expiryRows.length) return null;
  const strikes = [...new Set(expiryRows.map((row) => row.strike))];
  const strike = [...strikes].sort(
    (left, right) =>
      Math.abs(left - underlyingPrice) - Math.abs(right - underlyingPrice),
  )[0];
  if (strike === undefined) return null;
  const ivs = expiryRows
    .filter((row) => row.strike === strike && row.markIv !== null)
    .map((row) => row.markIv as number);
  const markIv = median(ivs);
  if (markIv === null) return null;
  return {
    expirationAt,
    daysToExpiry: Math.max(0, (expirationAt - now) / DAY_MS),
    strike,
    markIv,
  };
}

function skewPoint(
  rows: JoinedOption[],
  expirationAt: number | null,
  now: number,
): DeribitOptionsIntelligenceV2['skew25Delta']['sevenDay'] {
  if (expirationAt === null) return null;
  const candidates = rows
    .filter(
      (row) =>
        row.expirationAt === expirationAt &&
        row.markIv !== null &&
        row.underlyingPrice !== null,
    )
    .map((row) => ({ row, delta: optionDelta(row, now) }))
    .filter(
      (candidate): candidate is { row: JoinedOption; delta: number } =>
        candidate.delta !== null,
    );
  const call = candidates
    .filter((candidate) => candidate.row.optionType === 'call')
    .sort(
      (left, right) =>
        Math.abs(left.delta - 0.25) - Math.abs(right.delta - 0.25),
    )[0];
  const put = candidates
    .filter((candidate) => candidate.row.optionType === 'put')
    .sort(
      (left, right) =>
        Math.abs(Math.abs(left.delta) - 0.25) -
        Math.abs(Math.abs(right.delta) - 0.25),
    )[0];
  if (!call || !put) return null;
  if (Math.abs(call.delta - 0.25) > 0.15) return null;
  if (Math.abs(Math.abs(put.delta) - 0.25) > 0.15) return null;
  const callIv = call.row.markIv;
  const putIv = put.row.markIv;
  if (callIv === null || putIv === null) return null;
  return {
    expirationAt,
    daysToExpiry: Math.max(0, (expirationAt - now) / DAY_MS),
    putStrike: put.row.strike,
    putIv,
    callStrike: call.row.strike,
    callIv,
    putMinusCallIv: putIv - callIv,
  };
}

function provenance(
  now: number,
  dvol: DvolPoint | null,
): DataProvenance[] {
  const row = (
    source: string,
    sourceEventAt: number | null,
    metricNature: 'OBSERVED' | 'DERIVED',
  ): DataProvenance => ({
    source,
    venue: 'DERIBIT',
    instrument: 'BTC_OPTIONS',
    sourceEventAt,
    collectorReceivedAt: now,
    generatedAt: now,
    ageMs: sourceEventAt === null ? 0 : Math.max(0, now - sourceEventAt),
    collectorLagMs:
      sourceEventAt === null ? null : Math.max(0, now - sourceEventAt),
    processingLagMs: 0,
    metricNature,
    coverage: 'SNAPSHOT',
    status: 'NORMAL',
  });
  return [
    row('DERIBIT_GET_INSTRUMENTS', null, 'OBSERVED'),
    row('DERIBIT_BOOK_SUMMARY', null, 'OBSERVED'),
    ...(dvol ? [row('DERIBIT_DVOL', dvol.observedAt, 'OBSERVED')] : []),
    row('DERIBIT_OPTIONS_DERIVED', null, 'DERIVED'),
  ];
}

export function buildDeribitOptionsIntelligenceV2(input: {
  now: number;
  instruments: DeribitInstrumentRow[];
  summaries: DeribitSummaryRow[];
  dvol: DvolPoint | null;
}): DeribitOptionsIntelligenceV2 {
  const instrumentByName = new Map(
    input.instruments
      .filter((instrument) => instrument.is_active !== false)
      .map((instrument) => [instrument.instrument_name, instrument] as const),
  );
  const rows: JoinedOption[] = input.summaries.flatMap((summary) => {
    const instrument = instrumentByName.get(summary.instrument_name);
    if (!instrument) return [];
    return [
      {
        instrumentName: summary.instrument_name,
        expirationAt: instrument.expiration_timestamp,
        strike: instrument.strike,
        optionType: instrument.option_type,
        openInterest: finite(summary.open_interest) ?? 0,
        volume24h: finite(summary.volume) ?? 0,
        markIv: finite(summary.mark_iv),
        underlyingPrice: finite(summary.underlying_price),
        interestRate: finite(summary.interest_rate) ?? 0,
      },
    ];
  });
  const underlyingPrice = median(
    rows.flatMap((row) =>
      row.underlyingPrice === null ? [] : [row.underlyingPrice],
    ),
  );
  const expiries = [...new Set(rows.map((row) => row.expirationAt))].sort(
    (a, b) => a - b,
  );
  const nearExpiry = expiries.find((expiry) => expiry > input.now) ?? null;
  const sevenDayExpiry = closestExpiry(expiries, input.now, 7);
  const thirtyDayExpiry = closestExpiry(expiries, input.now, 30);
  const nearAtm = ivPoint(rows, nearExpiry, underlyingPrice, input.now);
  const sevenAtm = ivPoint(rows, sevenDayExpiry, underlyingPrice, input.now);
  const thirtyAtm = ivPoint(rows, thirtyDayExpiry, underlyingPrice, input.now);

  const oiByExpiry = expiries
    .filter((expirationAt) => expirationAt > input.now)
    .map((expirationAt) => {
      const expiryRows = rows.filter((row) => row.expirationAt === expirationAt);
      const putOpenInterestBtc = expiryRows
        .filter((row) => row.optionType === 'put')
        .reduce((sum, row) => sum + row.openInterest, 0);
      const callOpenInterestBtc = expiryRows
        .filter((row) => row.optionType === 'call')
        .reduce((sum, row) => sum + row.openInterest, 0);
      return {
        expirationAt,
        daysToExpiry: Math.max(0, (expirationAt - input.now) / DAY_MS),
        openInterestBtc: putOpenInterestBtc + callOpenInterestBtc,
        putOpenInterestBtc,
        callOpenInterestBtc,
        volume24hBtc: expiryRows.reduce((sum, row) => sum + row.volume24h, 0),
      };
    })
    .sort((a, b) => a.expirationAt - b.expirationAt)
    .slice(0, 24);

  const strikeMap = new Map<
    number,
    { putOpenInterestBtc: number; callOpenInterestBtc: number }
  >();
  if (underlyingPrice !== null) {
    for (const row of rows) {
      if (Math.abs(row.strike / underlyingPrice - 1) > 0.2) continue;
      const current = strikeMap.get(row.strike) ?? {
        putOpenInterestBtc: 0,
        callOpenInterestBtc: 0,
      };
      if (row.optionType === 'put') current.putOpenInterestBtc += row.openInterest;
      else current.callOpenInterestBtc += row.openInterest;
      strikeMap.set(row.strike, current);
    }
  }
  const nearbyLargestOiStrikes = [...strikeMap.entries()]
    .map(([strike, values]) => ({
      strike,
      distancePercent:
        underlyingPrice === null ? 0 : ((strike - underlyingPrice) / underlyingPrice) * 100,
      openInterestBtc:
        values.putOpenInterestBtc + values.callOpenInterestBtc,
      ...values,
    }))
    .sort((a, b) => b.openInterestBtc - a.openInterestBtc || a.strike - b.strike)
    .slice(0, 12);

  const putRows = rows.filter((row) => row.optionType === 'put');
  const callRows = rows.filter((row) => row.optionType === 'call');
  const putOpenInterestBtc = putRows.reduce(
    (sum, row) => sum + row.openInterest,
    0,
  );
  const callOpenInterestBtc = callRows.reduce(
    (sum, row) => sum + row.openInterest,
    0,
  );
  const putVolume24hBtc = putRows.reduce((sum, row) => sum + row.volume24h, 0);
  const callVolume24hBtc = callRows.reduce((sum, row) => sum + row.volume24h, 0);

  const output: DeribitOptionsIntelligenceV2 = {
    version: DERIBIT_OPTIONS_VERSION,
    generatedAt: input.now,
    objectiveOnly: true,
    source: 'DERIBIT',
    underlying: 'BTC',
    underlyingPrice,
    dvol: input.dvol,
    atmIv: {
      nearExpiry: nearAtm,
      sevenDay: sevenAtm,
      thirtyDay: thirtyAtm,
    },
    termStructure: {
      nearMinusThirtyDayIv:
        nearAtm && thirtyAtm ? nearAtm.markIv - thirtyAtm.markIv : null,
      sevenDayMinusThirtyDayIv:
        sevenAtm && thirtyAtm ? sevenAtm.markIv - thirtyAtm.markIv : null,
    },
    skew25Delta: {
      sevenDay: skewPoint(rows, sevenDayExpiry, input.now),
      thirtyDay: skewPoint(rows, thirtyDayExpiry, input.now),
    },
    putCall: {
      openInterestBtc: putOpenInterestBtc + callOpenInterestBtc,
      putOpenInterestBtc,
      callOpenInterestBtc,
      putCallOpenInterestRatio:
        callOpenInterestBtc > 0 ? putOpenInterestBtc / callOpenInterestBtc : null,
      volume24hBtc: putVolume24hBtc + callVolume24hBtc,
      putVolume24hBtc,
      callVolume24hBtc,
      putCallVolumeRatio:
        callVolume24hBtc > 0 ? putVolume24hBtc / callVolume24hBtc : null,
    },
    oiByExpiry,
    nearbyLargestOiStrikes,
    health: {
      instrumentCount: input.instruments.length,
      summaryCount: input.summaries.length,
      validIvCount: rows.filter((row) => row.markIv !== null).length,
      expirationCount: expiries.length,
      ageMs: input.dvol ? Math.max(0, input.now - input.dvol.observedAt) : 0,
    },
    provenance: provenance(input.now, input.dvol),
  };
  return deribitOptionsIntelligenceV2Schema.parse(output);
}

function dvolPoint(raw: unknown): DvolPoint | null {
  const root = z.object({ result: z.unknown() }).passthrough().parse(raw);
  const result = z
    .object({ data: z.array(z.array(z.number())).default([]) })
    .passthrough()
    .parse(root.result);
  const latest = result.data.at(-1);
  if (!latest || latest.length < 5) return null;
  const observedAt = latest[0];
  const value = latest[4];
  if (!Number.isFinite(observedAt) || !Number.isFinite(value)) return null;
  return { observedAt, value };
}

export async function fetchDeribitOptionsV2(
  now = Date.now(),
): Promise<DeribitOptionsIntelligenceV2> {
  const dvolStart = now - 10 * 60_000;
  const [instrumentsRaw, summariesRaw, dvolRaw] = await Promise.all([
    getJson(
      'https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false',
    ),
    getJson(
      'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option',
    ),
    getJson(
      `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${dvolStart}&end_timestamp=${now}&resolution=60`,
    ),
  ]);
  const instruments = resultRows(instrumentsRaw).map((row) =>
    instrumentSchema.parse(row),
  );
  const summaries = resultRows(summariesRaw).map((row) => summarySchema.parse(row));
  return buildDeribitOptionsIntelligenceV2({
    now,
    instruments,
    summaries,
    dvol: dvolPoint(dvolRaw),
  });
}

export function deribitOptionsContextItem(
  options: DeribitOptionsIntelligenceV2,
): ExternalContextItem {
  const dvol = options.dvol ? `DVOL ${options.dvol.value.toFixed(2)}` : 'DVOL n/a';
  const seven = options.atmIv.sevenDay
    ? `7d ATM IV ${options.atmIv.sevenDay.markIv.toFixed(2)}`
    : '7d ATM IV n/a';
  const thirty = options.atmIv.thirtyDay
    ? `30d ATM IV ${options.atmIv.thirtyDay.markIv.toFixed(2)}`
    : '30d ATM IV n/a';
  return item(
    'DERIBIT',
    'OPTIONS',
    `BTC options: ${dvol}, ${seven}, ${thirty}`,
    'https://www.deribit.com/statistics/BTC/options-data',
    options.generatedAt,
    options.generatedAt,
    'OFFICIAL',
    'Structured Deribit Options V2 snapshot; objective options-market evidence, not a directional or price-target signal.',
    ['options', 'dvol', 'atm-iv', 'skew', 'open-interest'],
  );
}
''')

write('tests/unit/deribit-options-v2.test.ts', r'''import { describe, expect, it } from 'vitest';

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
    expect(result.provenance.map((row) => row.metricNature)).toContain('DERIVED');
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
''')

# Contracts: add the structured options payload to ExternalContextSnapshot.
replace_once(
    'src/shared/contracts.ts',
    "import type {\n  ApprovedPlanMonitoring,\n  StructuredTriggerInput,\n} from './trading/structured-trigger';",
    "import type {\n  ApprovedPlanMonitoring,\n  StructuredTriggerInput,\n} from './trading/structured-trigger';\nimport type { DeribitOptionsIntelligenceV2 } from './options-intelligence';",
)
replace_once(
    'src/shared/contracts.ts',
    "  items: ExternalContextItem[];\n  sourceHealth: Record<string, ExternalSourceHealth>;\n  riskContext: RiskContext;\n}",
    "  items: ExternalContextItem[];\n  sourceHealth: Record<string, ExternalSourceHealth>;\n  riskContext: RiskContext;\n  optionsV2: DeribitOptionsIntelligenceV2 | null;\n}",
)

# External service: fetch and retain structured Deribit evidence.
replace_once(
    'src/main/external/service.ts',
    "import { fetchRss, item, officialFeeds, sourceAdapters } from './adapters';",
    "import { fetchRss, item, officialFeeds, sourceAdapters } from './adapters';\nimport {\n  deribitOptionsContextItem,\n  fetchDeribitOptionsV2,\n} from './options-v2';\nimport type { DeribitOptionsIntelligenceV2 } from '../../shared/options-intelligence';",
)
replace_once(
    'src/main/external/service.ts',
    "  private stopped = true;\n  private updatedAt: number | null = null;",
    "  private stopped = true;\n  private updatedAt: number | null = null;\n  private deribitOptionsV2: DeribitOptionsIntelligenceV2 | null = null;",
)
replace_once(
    'src/main/external/service.ts',
    "      sourceHealth,\n      riskContext: this.riskContext(now, sourceHealth),\n    };",
    "      sourceHealth,\n      riskContext: this.riskContext(now, sourceHealth),\n      optionsV2: this.deribitOptionsV2,\n    };",
)
replace_once(
    'src/main/external/service.ts',
    "      if (source === 'DERIBIT') records = await sourceAdapters.deribit();",
    "      if (source === 'DERIBIT') {\n        const optionsV2 = await fetchDeribitOptionsV2();\n        this.deribitOptionsV2 = optionsV2;\n        records = [deribitOptionsContextItem(optionsV2)];\n      }",
)

# Worker upload validation: accept optionsV2 while keeping rollout compatibility.
replace_once(
    'worker/src/index.ts',
    "    riskContext: riskContextSchema,\n  })\n  .strict();",
    "    riskContext: riskContextSchema,\n    optionsV2: z.unknown().nullable().optional(),\n  })\n  .strict();",
)

# Context router: surface structured options in the official Decision Context.
replace_once(
    'worker/src/phase20-context-router.ts',
    "    riskContext: unknown;\n    selectedItems: Array<Record<string, unknown>>;",
    "    riskContext: unknown;\n    optionsV2: unknown;\n    selectedItems: Array<Record<string, unknown>>;",
)
replace_once(
    'worker/src/phase20-context-router.ts',
    "    externalAvailable: boolean;\n    btcDecisionGateQuality: string | null;",
    "    externalAvailable: boolean;\n    optionsAvailable: boolean;\n    btcDecisionGateQuality: string | null;",
)
replace_once(
    'worker/src/phase20-context-router.ts',
    "  for (const item of selectedItems) {\n    if (typeof item.source === 'string') sourceSet.add(item.source);\n  }",
    "  for (const item of selectedItems) {\n    if (typeof item.source === 'string') sourceSet.add(item.source);\n  }\n  if (asRecord(externalRoot?.optionsV2)) sourceSet.add('DERIBIT_OPTIONS_V2');",
)
replace_once(
    'worker/src/phase20-context-router.ts',
    "      riskContext: externalRoot?.riskContext ?? at(snapshot, 'riskContext'),\n      selectedItems,",
    "      riskContext: externalRoot?.riskContext ?? at(snapshot, 'riskContext'),\n      optionsV2: externalRoot?.optionsV2 ?? null,\n      selectedItems,",
)
replace_once(
    'worker/src/phase20-context-router.ts',
    "      externalAvailable: external !== null,\n      btcDecisionGateQuality:",
    "      externalAvailable: external !== null,\n      optionsAvailable: asRecord(externalRoot?.optionsV2) !== null,\n      btcDecisionGateQuality:",
)

# OpenAPI: add a strict-ish structured schema and expose it on both external endpoints.
openapi_path = ROOT / 'worker/openapi/openapi.json'
openapi = json.loads(openapi_path.read_text(encoding='utf-8'))
openapi['info']['version'] = '5.7.0'
schemas = openapi['components']['schemas']
schemas['DeribitOptionsV2'] = {
    'type': 'object',
    'additionalProperties': False,
    'required': [
        'version', 'generatedAt', 'objectiveOnly', 'source', 'underlying',
        'underlyingPrice', 'dvol', 'atmIv', 'termStructure', 'skew25Delta',
        'putCall', 'oiByExpiry', 'nearbyLargestOiStrikes', 'health', 'provenance'
    ],
    'properties': {
        'version': {'type': 'string', 'const': 'deribit-options-v2'},
        'generatedAt': {'type': 'integer'},
        'objectiveOnly': {'type': 'boolean', 'const': True},
        'source': {'type': 'string', 'const': 'DERIBIT'},
        'underlying': {'type': 'string', 'const': 'BTC'},
        'underlyingPrice': {'type': ['number', 'null']},
        'dvol': {
            'oneOf': [
                {'type': 'object', 'additionalProperties': False, 'required': ['value', 'observedAt'], 'properties': {'value': {'type': 'number'}, 'observedAt': {'type': 'integer'}}},
                {'type': 'null'}
            ]
        },
        'atmIv': {'type': 'object', 'additionalProperties': True, 'description': 'Near-expiry, ~7d and ~30d ATM mark IV observations.'},
        'termStructure': {'type': 'object', 'additionalProperties': False, 'required': ['nearMinusThirtyDayIv', 'sevenDayMinusThirtyDayIv'], 'properties': {'nearMinusThirtyDayIv': {'type': ['number', 'null']}, 'sevenDayMinusThirtyDayIv': {'type': ['number', 'null']}}},
        'skew25Delta': {'type': 'object', 'additionalProperties': True, 'description': 'Approximate 25-delta put/call mark-IV observations; skew is put IV minus call IV.'},
        'putCall': {'type': 'object', 'additionalProperties': True, 'description': 'Observed Deribit BTC option open-interest and 24h volume aggregates.'},
        'oiByExpiry': {'type': 'array', 'maxItems': 24, 'items': {'type': 'object', 'additionalProperties': True}},
        'nearbyLargestOiStrikes': {'type': 'array', 'maxItems': 12, 'items': {'type': 'object', 'additionalProperties': True}},
        'health': {'type': 'object', 'additionalProperties': True},
        'provenance': {'type': 'array', 'items': {'$ref': '#/components/schemas/DataProvenance'}},
    },
    'description': 'Objective Deribit BTC options-market evidence. It is not a LONG/SHORT, arbitrage, max-pain, or price-target signal.'
}
external_schema = schemas.get('ExternalContext')
if not external_schema or 'properties' not in external_schema:
    raise SystemExit('ExternalContext schema missing')
external_schema['properties']['optionsV2'] = {
    'oneOf': [{'$ref': '#/components/schemas/DeribitOptionsV2'}, {'type': 'null'}]
}
decision_schema = schemas.get('DecisionContext')
if not decision_schema or 'properties' not in decision_schema:
    raise SystemExit('DecisionContext schema missing')
decision_external = decision_schema['properties'].get('external')
if not isinstance(decision_external, dict):
    raise SystemExit('DecisionContext.external missing')
if 'properties' in decision_external:
    decision_external['properties']['optionsV2'] = {
        'oneOf': [{'$ref': '#/components/schemas/DeribitOptionsV2'}, {'type': 'null'}]
    }
else:
    decision_external['description'] = (
        str(decision_external.get('description', '')) +
        ' Includes optionsV2 structured Deribit BTC options evidence when available.'
    ).strip()
openapi_path.write_text(json.dumps(openapi, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

# OpenAPI tests: bump version and assert the structured schema/boundary exists.
replace_once(
    'tests/unit/worker.openapi.test.ts',
    "      CrossVenueIntelligence: {\n        additionalProperties: boolean;\n        required: string[];\n      };",
    "      CrossVenueIntelligence: {\n        additionalProperties: boolean;\n        required: string[];\n      };\n      DeribitOptionsV2: {\n        additionalProperties: boolean;\n        required: string[];\n        properties: { version: { const: string }; objectiveOnly: { const: boolean } };\n      };",
)
replace_once(
    'tests/unit/worker.openapi.test.ts',
    "    expect(json.info.version).toBe('5.6.0');",
    "    expect(json.info.version).toBe('5.7.0');",
)
replace_once(
    'tests/unit/worker.openapi.test.ts',
    "    expect(json.components.schemas.CrossVenueIntelligence.required).toContain(\n      'interpretationBoundary',\n    );",
    "    expect(json.components.schemas.CrossVenueIntelligence.required).toContain(\n      'interpretationBoundary',\n    );\n    expect(json.components.schemas.DeribitOptionsV2.additionalProperties).toBe(\n      false,\n    );\n    expect(json.components.schemas.DeribitOptionsV2.required).toContain(\n      'skew25Delta',\n    );\n    expect(json.components.schemas.DeribitOptionsV2.properties.version.const).toBe(\n      'deribit-options-v2',\n    );\n    expect(\n      json.components.schemas.DeribitOptionsV2.properties.objectiveOnly.const,\n    ).toBe(true);",
)

# GPT instructions: expose the fields and preserve the no-signal boundary while staying under editor limit.
instructions_path = ROOT / 'worker/openapi/GPT_INSTRUCTIONS.md'
instructions = instructions_path.read_text(encoding='utf-8')
old_line = '- `external`: 선별 뉴스/매크로/옵션/온체인. 누락/캐시값을 추측하지 않는다.'
new_line = '- `external`: 뉴스/매크로/온체인 + `optionsV2`(DVOL·ATM IV·term·25Δ skew·put/call OI/volume). 옵션은 보조증거이며 방향/목표가 신호가 아니다.'
if old_line not in instructions:
    raise SystemExit('GPT external anchor missing')
instructions = instructions.replace(old_line, new_line, 1)
shortenings = [
    ('- 실시간 판단에서 현재 case의 replay future outcome은 절대 사용하지 않는다.', '- 현재 case의 replay future outcome은 사용 금지.'),
    ('- 호가벽 단독 진입 금지. 모든 지표 만장일치도 요구하지 않는다.', '- 호가벽 단독 진입 금지. 지표 만장일치도 요구하지 않는다.'),
    ('프로그램의 crypto-market, cross-market, memory, reasoning policy, management telemetry는 증거/라우팅일 뿐 LONG/SHORT 신호가 아니다.', 'crypto-market, cross-market, memory, reasoning policy, management telemetry는 증거/라우팅이며 LONG/SHORT 신호가 아니다.'),
]
for old, new in shortenings:
    if len(instructions) <= 7480:
        break
    instructions = instructions.replace(old, new, 1)
if len(instructions) > 7500:
    raise SystemExit(f'GPT instructions still too long: {len(instructions)}')
instructions_path.write_text(instructions, encoding='utf-8', newline='\n')

# Unit test for worker context upload strictness and context routing is covered indirectly by existing tests;
# add a direct expectation to the Decision Context fixture test when its stable anchor exists.
decision_test = ROOT / 'tests/unit/decision-context-v1.test.ts'
text = decision_test.read_text(encoding='utf-8')
if "expect(context.version).toBe('decision-context-v1');" in text and 'optionsV2' not in text:
    text = text.replace(
        "expect(context.version).toBe('decision-context-v1');",
        "expect(context.version).toBe('decision-context-v1');\n    expect(context.external).toHaveProperty('optionsV2');",
        1,
    )
    decision_test.write_text(text, encoding='utf-8', newline='\n')

print('Deribit Options V2 patch staged')
