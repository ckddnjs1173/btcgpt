import {
  dataProvenanceSchema,
  type DataProvenance,
  type EvidenceCoverage,
  type EvidenceStatus,
  type MetricNature,
} from '../../../shared/market-intelligence';

export function buildDataProvenance(input: {
  source: string;
  venue?: string | null;
  instrument?: string | null;
  sourceEventAt?: number | null;
  collectorReceivedAt: number;
  generatedAt: number;
  metricNature: MetricNature;
  coverage: EvidenceCoverage;
  status: EvidenceStatus;
  now?: number;
}): DataProvenance {
  const referenceAt = input.sourceEventAt ?? input.collectorReceivedAt;
  const now = input.now ?? input.generatedAt;
  return dataProvenanceSchema.parse({
    source: input.source,
    venue: input.venue ?? null,
    instrument: input.instrument ?? null,
    sourceEventAt: input.sourceEventAt ?? null,
    collectorReceivedAt: input.collectorReceivedAt,
    generatedAt: input.generatedAt,
    ageMs: Math.max(0, Math.trunc(now - referenceAt)),
    collectorLagMs:
      input.sourceEventAt === null || input.sourceEventAt === undefined
        ? null
        : Math.trunc(input.collectorReceivedAt - input.sourceEventAt),
    processingLagMs: Math.max(
      0,
      Math.trunc(input.generatedAt - input.collectorReceivedAt),
    ),
    metricNature: input.metricNature,
    coverage: input.coverage,
    status: input.status,
  });
}
