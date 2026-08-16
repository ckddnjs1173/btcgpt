import { z } from 'zod';

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
      ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
        t *
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
  const r =
    Math.abs(row.interestRate) > 1 ? row.interestRate / 100 : row.interestRate;
  const d1 =
    (Math.log(row.underlyingPrice / row.strike) +
      (r + (sigma * sigma) / 2) * t) /
    (sigma * Math.sqrt(t));
  const call = normalCdf(d1);
  return row.optionType === 'call' ? call : call - 1;
}

function closestExpiry(
  expiries: number[],
  now: number,
  days: number,
): number | null {
  const usable = expiries.filter((expiry) => expiry > now);
  if (!usable.length) return null;
  const target = now + days * DAY_MS;
  return (
    [...usable].sort(
      (left, right) => Math.abs(left - target) - Math.abs(right - target),
    )[0] ?? null
  );
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

function provenance(now: number, dvol: DvolPoint | null): DataProvenance[] {
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
      const expiryRows = rows.filter(
        (row) => row.expirationAt === expirationAt,
      );
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
      if (row.optionType === 'put')
        current.putOpenInterestBtc += row.openInterest;
      else current.callOpenInterestBtc += row.openInterest;
      strikeMap.set(row.strike, current);
    }
  }
  const nearbyLargestOiStrikes = [...strikeMap.entries()]
    .map(([strike, values]) => ({
      strike,
      distancePercent:
        underlyingPrice === null
          ? 0
          : ((strike - underlyingPrice) / underlyingPrice) * 100,
      openInterestBtc: values.putOpenInterestBtc + values.callOpenInterestBtc,
      ...values,
    }))
    .sort(
      (a, b) => b.openInterestBtc - a.openInterestBtc || a.strike - b.strike,
    )
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
  const callVolume24hBtc = callRows.reduce(
    (sum, row) => sum + row.volume24h,
    0,
  );

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
        callOpenInterestBtc > 0
          ? putOpenInterestBtc / callOpenInterestBtc
          : null,
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
  const observedAt = latest[0] ?? Number.NaN;
  const value = latest[4] ?? Number.NaN;
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
  const summaries = resultRows(summariesRaw).map((row) =>
    summarySchema.parse(row),
  );
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
  const dvol = options.dvol
    ? `DVOL ${options.dvol.value.toFixed(2)}`
    : 'DVOL n/a';
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
