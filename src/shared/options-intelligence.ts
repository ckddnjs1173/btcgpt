import { z } from 'zod';

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
