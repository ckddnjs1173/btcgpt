import { z } from 'zod';

import type { AltMarketIntelligence } from './alt-market-intelligence';
import {
  dataProvenanceSchema,
  evidenceHealthSchema,
  type LeadAssetObservation,
} from './market-intelligence';

export const LOCAL_MARKET_INTELLIGENCE_VERSION = 'local-market-v1' as const;
export const DECISION_CONTEXT_VERSION = 'decision-context-v1' as const;

const finite = z.number().finite();
const nullableFinite = finite.nullable();
const epochMs = z.number().int().nonnegative();

const returnWindowsSchema = z
  .object({
    '15s': nullableFinite.optional(),
    '30s': nullableFinite.optional(),
    '1m': nullableFinite,
    '3m': nullableFinite,
    '5m': nullableFinite,
    '15m': nullableFinite,
    '1h': nullableFinite,
  })
  .strict();

const compactLeadSchema = z
  .object({
    symbol: z.enum(['ETHUSDT', 'SOLUSDT']),
    generatedAt: epochMs,
    market: z
      .object({
        lastPrice: z.number().positive().nullable(),
        markPrice: z.number().positive().nullable(),
        bidPrice: z.number().positive().nullable(),
        askPrice: z.number().positive().nullable(),
        spreadBps: nullableFinite,
        fundingRate: nullableFinite,
      })
      .strict(),
    returnsBps: returnWindowsSchema,
    flow: z
      .object({
        '15s': z
          .object({
            normalizedDelta: z.number().min(-1).max(1).nullable(),
            buyRatio: z.number().min(0).max(1).nullable(),
            tradesPerSecond: z.number().nonnegative(),
          })
          .strict(),
        '1m': z
          .object({
            normalizedDelta: z.number().min(-1).max(1).nullable(),
            buyRatio: z.number().min(0).max(1).nullable(),
            tradesPerSecond: z.number().nonnegative(),
          })
          .strict(),
        '5m': z
          .object({
            normalizedDelta: z.number().min(-1).max(1).nullable(),
            buyRatio: z.number().min(0).max(1).nullable(),
            tradesPerSecond: z.number().nonnegative(),
          })
          .strict(),
        cumulativeDeltaNotional: finite,
      })
      .strict(),
    microstructure: z
      .object({
        bidNotional20: z.number().nonnegative(),
        askNotional20: z.number().nonnegative(),
        depthImbalance20: z.number().min(-1).max(1).nullable(),
        microPrice: z.number().positive().nullable(),
      })
      .strict(),
    openInterest: z
      .object({
        current: z.number().nonnegative().nullable(),
        notional: z.number().nonnegative().nullable(),
        observedAt: epochMs.nullable(),
        changesPercent: z
          .object({
            '1m': nullableFinite,
            '5m': nullableFinite,
            '15m': nullableFinite,
          })
          .strict(),
      })
      .strict(),
    liquidations: z
      .object({
        '5m': z
          .object({
            observedLongNotional: z.number().nonnegative(),
            observedShortNotional: z.number().nonnegative(),
            eventCount: z.number().int().nonnegative(),
            coverage: z.literal('SNAPSHOT'),
          })
          .strict(),
        '15m': z
          .object({
            observedLongNotional: z.number().nonnegative(),
            observedShortNotional: z.number().nonnegative(),
            eventCount: z.number().int().nonnegative(),
            coverage: z.literal('SNAPSHOT'),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const compactAltAssetSchema = z
  .object({
    symbol: z.string().min(3).max(32),
    tier: z.enum(['SENTIMENT_CORE', 'DYNAMIC']),
    generatedAt: epochMs,
    market: z
      .object({
        lastPrice: z.number().positive().nullable(),
        markPrice: z.number().positive().nullable(),
        spreadBps: nullableFinite,
        fundingRate: nullableFinite,
      })
      .strict(),
    returnsBps: z
      .object({
        '1m': nullableFinite,
        '3m': nullableFinite,
        '5m': nullableFinite,
        '15m': nullableFinite,
        '1h': nullableFinite,
      })
      .strict(),
    delta: z
      .object({
        '1m': z.number().min(-1).max(1).nullable(),
        '5m': z.number().min(-1).max(1).nullable(),
        '15m': z.number().min(-1).max(1).nullable(),
      })
      .strict(),
    openInterestChangePercent: z
      .object({
        '1m': nullableFinite,
        '5m': nullableFinite,
        '15m': nullableFinite,
      })
      .strict(),
  })
  .strict();

const compactAltMarketSchema = z
  .object({
    generatedAt: epochMs,
    basketMembers: z.array(z.string().min(3).max(32)).max(20),
    sentimentCore: z.array(compactAltAssetSchema).max(20),
    dynamic: z.array(compactAltAssetSchema).max(20),
    breadth: z.unknown(),
    relativeStrength: z.unknown(),
    rotation: z.unknown(),
  })
  .strict();

export const localMarketIntelligenceSchema = z
  .object({
    version: z.literal(LOCAL_MARKET_INTELLIGENCE_VERSION),
    generatedAt: epochMs,
    objectiveOnly: z.literal(true),
    leadCore: z
      .object({
        ETHUSDT: compactLeadSchema.nullable(),
        SOLUSDT: compactLeadSchema.nullable(),
      })
      .strict(),
    altMarket: compactAltMarketSchema.nullable(),
    evidenceHealth: z.array(evidenceHealthSchema).max(128),
    provenance: z.array(dataProvenanceSchema).max(32),
  })
  .strict();

export type LocalMarketIntelligence = z.infer<
  typeof localMarketIntelligenceSchema
>;

function compactLead(
  observation: LeadAssetObservation | null,
): z.infer<typeof compactLeadSchema> | null {
  if (!observation) return null;
  return compactLeadSchema.parse({
    symbol: observation.symbol,
    generatedAt: observation.generatedAt,
    market: {
      lastPrice: observation.market.lastPrice,
      markPrice: observation.market.markPrice,
      bidPrice: observation.market.bidPrice,
      askPrice: observation.market.askPrice,
      spreadBps: observation.market.spreadBps,
      fundingRate: observation.market.fundingRate,
    },
    returnsBps: observation.returnsBps,
    flow: {
      '15s': {
        normalizedDelta: observation.tradeFlow['15s'].normalizedDelta,
        buyRatio: observation.tradeFlow['15s'].buyRatio,
        tradesPerSecond: observation.tradeFlow['15s'].tradesPerSecond,
      },
      '1m': {
        normalizedDelta: observation.tradeFlow['1m'].normalizedDelta,
        buyRatio: observation.tradeFlow['1m'].buyRatio,
        tradesPerSecond: observation.tradeFlow['1m'].tradesPerSecond,
      },
      '5m': {
        normalizedDelta: observation.tradeFlow['5m'].normalizedDelta,
        buyRatio: observation.tradeFlow['5m'].buyRatio,
        tradesPerSecond: observation.tradeFlow['5m'].tradesPerSecond,
      },
      cumulativeDeltaNotional: observation.tradeFlow.cumulativeDeltaNotional,
    },
    microstructure: {
      bidNotional20: observation.microstructure.bidNotional20,
      askNotional20: observation.microstructure.askNotional20,
      depthImbalance20: observation.microstructure.depthImbalance20,
      microPrice: observation.microstructure.microPrice,
    },
    openInterest: {
      current: observation.openInterest.current,
      notional: observation.openInterest.notional,
      observedAt: observation.openInterest.observedAt,
      changesPercent: {
        '1m': observation.openInterest.changesPercent['1m'],
        '5m': observation.openInterest.changesPercent['5m'],
        '15m': observation.openInterest.changesPercent['15m'],
      },
    },
    liquidations: {
      '5m': observation.liquidations['5m'],
      '15m': observation.liquidations['15m'],
    },
  });
}

function compactAltAsset(
  observation: AltMarketIntelligence['dynamic'][number],
): z.infer<typeof compactAltAssetSchema> {
  return compactAltAssetSchema.parse({
    symbol: observation.symbol,
    tier: observation.tier,
    generatedAt: observation.generatedAt,
    market: {
      lastPrice: observation.market.lastPrice,
      markPrice: observation.market.markPrice,
      spreadBps: observation.market.spreadBps,
      fundingRate: observation.market.fundingRate,
    },
    returnsBps: observation.returnsBps,
    delta: {
      '1m': observation.flow['1m'].normalizedDelta,
      '5m': observation.flow['5m'].normalizedDelta,
      '15m': observation.flow['15m'].normalizedDelta,
    },
    openInterestChangePercent: observation.openInterest.changesPercent,
  });
}

export function buildLocalMarketIntelligence(input: {
  generatedAt: number;
  leadCore: {
    ETHUSDT: LeadAssetObservation | null;
    SOLUSDT: LeadAssetObservation | null;
  };
  altMarket: AltMarketIntelligence | null;
  evidenceHealth: LocalMarketIntelligence['evidenceHealth'];
}): LocalMarketIntelligence {
  const provenance = [
    ...(input.leadCore.ETHUSDT?.provenance ?? []),
    ...(input.leadCore.SOLUSDT?.provenance ?? []),
    ...(input.altMarket?.provenance ?? []),
  ]
    .sort((a, b) => b.collectorReceivedAt - a.collectorReceivedAt)
    .filter(
      (row, index, rows) =>
        rows.findIndex(
          (candidate) =>
            candidate.source === row.source &&
            candidate.instrument === row.instrument,
        ) === index,
    )
    .slice(0, 32);

  return localMarketIntelligenceSchema.parse({
    version: LOCAL_MARKET_INTELLIGENCE_VERSION,
    generatedAt: input.generatedAt,
    objectiveOnly: true,
    leadCore: {
      ETHUSDT: compactLead(input.leadCore.ETHUSDT),
      SOLUSDT: compactLead(input.leadCore.SOLUSDT),
    },
    altMarket: input.altMarket
      ? {
          generatedAt: input.altMarket.generatedAt,
          basketMembers: input.altMarket.basket.members.map(
            (member) => member.symbol,
          ),
          sentimentCore: input.altMarket.sentimentCore.map(compactAltAsset),
          dynamic: input.altMarket.dynamic.map(compactAltAsset),
          breadth: input.altMarket.breadth,
          relativeStrength: input.altMarket.relativeStrength,
          rotation: input.altMarket.rotation,
        }
      : null,
    evidenceHealth: input.evidenceHealth,
    provenance,
  });
}
