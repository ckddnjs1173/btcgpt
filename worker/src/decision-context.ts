import { z } from 'zod';

import {
  DECISION_CONTEXT_VERSION,
  localMarketIntelligenceSchema,
  type LocalMarketIntelligence,
} from '../../src/shared/decision-context';
import type { buildContextPack } from './phase20-context-router';

const recordSchema = z.record(z.string(), z.unknown());
type ContextPack = Awaited<ReturnType<typeof buildContextPack>>;

type SnapshotRecord = Record<string, unknown>;

function record(value: unknown): SnapshotRecord | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function localMarket(snapshot: SnapshotRecord): LocalMarketIntelligence | null {
  const parsed = localMarketIntelligenceSchema.safeParse(
    snapshot.marketIntelligence ?? null,
  );
  return parsed.success ? parsed.data : null;
}

export type DecisionContext = ReturnType<typeof buildDecisionContext>;

export function buildDecisionContext(input: {
  snapshot: SnapshotRecord;
  contextPack: ContextPack;
  relayReceivedAt: number;
  actionStartedAt: number;
  generatedAt?: number;
}) {
  const generatedAt = input.generatedAt ?? Date.now();
  const marketGeneratedAt =
    number(input.snapshot.generatedAt) ?? input.contextPack.marketGeneratedAt;
  const cryptoMarket = localMarket(input.snapshot);
  const decisionGates = record(input.contextPack.btcCore.decisionGates) ?? {};
  const marketAgeMs =
    marketGeneratedAt === null ? null : Math.max(0, generatedAt - marketGeneratedAt);
  const marketToRelayMs =
    marketGeneratedAt === null
      ? null
      : Math.max(0, input.relayReceivedAt - marketGeneratedAt);

  return {
    version: DECISION_CONTEXT_VERSION,
    generatedAt,
    objectiveOnly: true as const,
    snapshotId:
      text(input.snapshot.snapshotId) ?? input.contextPack.snapshotId ?? null,
    marketGeneratedAt,
    relayReceivedAt: input.relayReceivedAt,
    decisionGates,
    btcCore: input.contextPack.btcCore,
    cryptoMarket,
    crossMarket: input.contextPack.crossMarket,
    external: input.contextPack.external,
    tradingMemory: input.contextPack.tradingMemory,
    reasoningPolicy: input.contextPack.reasoningPolicy,
    positionManagement: input.contextPack.positionManagement,
    timing: {
      marketAgeMs,
      marketToRelayMs,
      relayToActionStartMs: Math.max(
        0,
        input.actionStartedAt - input.relayReceivedAt,
      ),
      contextBuildMs: Math.max(0, generatedAt - input.actionStartedAt),
    },
    evidence: {
      cryptoMarketAvailable: cryptoMarket !== null,
      cryptoMarketGeneratedAt: cryptoMarket?.generatedAt ?? null,
      cryptoMarketAgeMs:
        cryptoMarket === null
          ? null
          : Math.max(0, generatedAt - cryptoMarket.generatedAt),
      auxiliaryEvidenceHealth: cryptoMarket?.evidenceHealth ?? [],
      provenance: cryptoMarket?.provenance ?? [],
    },
    routing: input.contextPack.routing,
    completeness: {
      ...input.contextPack.completeness,
      cryptoMarketAvailable: cryptoMarket !== null,
      leadAssetsAvailable: cryptoMarket
        ? [
            cryptoMarket.leadCore.ETHUSDT !== null,
            cryptoMarket.leadCore.SOLUSDT !== null,
          ].filter(Boolean).length
        : 0,
      dynamicAssetCount: cryptoMarket?.altMarket?.dynamic.length ?? 0,
    },
  };
}
