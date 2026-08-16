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
        raise SystemExit(f'anchor missing in {path}: {old[:140]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8', newline='\n')


write('src/shared/onchain-intelligence.ts', r'''import { z } from 'zod';

import { dataProvenanceSchema } from './market-intelligence';

export const ONCHAIN_INTELLIGENCE_VERSION = 'onchain-v1' as const;

const epochMs = z.number().int().nonnegative();
const nullableNonnegative = z.number().finite().nonnegative().nullable();
const nullableCount = z.number().int().nonnegative().nullable();

export const mempoolObservationSchema = z
  .object({
    observedAt: epochMs,
    transactionCount: nullableCount,
    virtualSizeBytes: nullableCount,
    totalFeeSats: nullableNonnegative,
    recommendedFees: z
      .object({
        fastestFeeSatVb: nullableNonnegative,
        halfHourFeeSatVb: nullableNonnegative,
        hourFeeSatVb: nullableNonnegative,
        economyFeeSatVb: nullableNonnegative,
        minimumFeeSatVb: nullableNonnegative,
      })
      .strict(),
  })
  .strict();
export type MempoolObservation = z.infer<typeof mempoolObservationSchema>;

export const networkDailyObservationSchema = z
  .object({
    periodAt: epochMs,
    observedAt: epochMs,
    activeAddressCount: nullableNonnegative,
    transactionCount: nullableNonnegative,
    totalFeesBtc: nullableNonnegative,
    metricNature: z.literal('REVISED'),
  })
  .strict();
export type NetworkDailyObservation = z.infer<
  typeof networkDailyObservationSchema
>;

export const onchainIntelligenceV1Schema = z
  .object({
    version: z.literal(ONCHAIN_INTELLIGENCE_VERSION),
    generatedAt: epochMs,
    objectiveOnly: z.literal(true),
    role: z.literal('BACKGROUND_REGIME_ONLY'),
    mempool: mempoolObservationSchema.nullable(),
    networkDaily: networkDailyObservationSchema.nullable(),
    health: z
      .object({
        mempoolCollectionAgeMs: z.number().int().nonnegative().nullable(),
        networkDailyCollectionAgeMs: z.number().int().nonnegative().nullable(),
        networkDailyPeriodAgeMs: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    provenance: z.array(dataProvenanceSchema).max(8),
  })
  .strict();

export type OnchainIntelligenceV1 = z.infer<typeof onchainIntelligenceV1Schema>;
''')

write('src/main/external/provider-contracts.ts', r'''import { z } from 'zod';

import type { ExternalContextItem } from '../../shared/contracts';
import type {
  DataProvenance,
  EvidenceCoverage,
  MetricNature,
} from '../../shared/market-intelligence';

export type ExternalProviderKind =
  | 'DERIVATIVES_AGGREGATE'
  | 'ONCHAIN'
  | 'ESTIMATED_LIQUIDATION'
  | 'ETF';

export interface ProviderFetchResult<T> {
  providerId: string;
  kind: ExternalProviderKind;
  generatedAt: number;
  payload: T;
  provenance: DataProvenance[];
  items: ExternalContextItem[];
}

export interface ExternalIntelligenceProvider<T> {
  readonly providerId: string;
  readonly kind: ExternalProviderKind;
  fetch(now?: number): Promise<ProviderFetchResult<T>>;
}

export interface DerivativesAggregateProvider<T = unknown>
  extends ExternalIntelligenceProvider<T> {
  readonly kind: 'DERIVATIVES_AGGREGATE';
}

export interface OnchainProvider<T = unknown>
  extends ExternalIntelligenceProvider<T> {
  readonly kind: 'ONCHAIN';
}

export interface EstimatedLiquidationProvider<T = unknown>
  extends ExternalIntelligenceProvider<T> {
  readonly kind: 'ESTIMATED_LIQUIDATION';
}

export interface ETFProvider<T = unknown> extends ExternalIntelligenceProvider<T> {
  readonly kind: 'ETF';
}

export const estimatedLiquidationLevelSchema = z
  .object({
    price: z.number().positive(),
    estimatedLongLiquidationNotionalUsd: z.number().nonnegative().nullable(),
    estimatedShortLiquidationNotionalUsd: z.number().nonnegative().nullable(),
    metricNature: z.literal('ESTIMATED') satisfies z.ZodType<MetricNature>,
    coverage: z.enum(['SAMPLED', 'UNKNOWN']) satisfies z.ZodType<
      Extract<EvidenceCoverage, 'SAMPLED' | 'UNKNOWN'>
    >,
  })
  .strict();

export type EstimatedLiquidationLevel = z.infer<
  typeof estimatedLiquidationLevelSchema
>;
''')

write('src/main/external/onchain-v1.ts', r'''import { z } from 'zod';

import type { ExternalContextItem } from '../../shared/contracts';
import type { DataProvenance } from '../../shared/market-intelligence';
import {
  ONCHAIN_INTELLIGENCE_VERSION,
  mempoolObservationSchema,
  networkDailyObservationSchema,
  onchainIntelligenceV1Schema,
  type MempoolObservation,
  type NetworkDailyObservation,
  type OnchainIntelligenceV1,
} from '../../shared/onchain-intelligence';
import { buildDataProvenance } from '../market/intelligence/provenance';
import { item } from './adapters';

const REQUEST_TIMEOUT_MS = 10_000;
const jsonRecord = z.record(z.string(), z.unknown());

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function integerOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.trunc(parsed);
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ONCHAIN_HTTP_${response.status}`);
  return response.json() as Promise<unknown>;
}

export async function fetchMempoolObservation(
  observedAt = Date.now(),
): Promise<{ observation: MempoolObservation; item: ExternalContextItem }> {
  const [feesRaw, mempoolRaw] = await Promise.all([
    getJson('https://mempool.space/api/v1/fees/recommended'),
    getJson('https://mempool.space/api/mempool'),
  ]);
  const fees = jsonRecord.parse(feesRaw);
  const mempool = jsonRecord.parse(mempoolRaw);
  const observation = mempoolObservationSchema.parse({
    observedAt,
    transactionCount: integerOrNull(mempool.count),
    virtualSizeBytes: integerOrNull(mempool.vsize),
    totalFeeSats: numberOrNull(mempool.total_fee),
    recommendedFees: {
      fastestFeeSatVb: numberOrNull(fees.fastestFee),
      halfHourFeeSatVb: numberOrNull(fees.halfHourFee),
      hourFeeSatVb: numberOrNull(fees.hourFee),
      economyFeeSatVb: numberOrNull(fees.economyFee),
      minimumFeeSatVb: numberOrNull(fees.minimumFee),
    },
  });
  const count =
    observation.transactionCount === null
      ? 'unknown backlog'
      : `${observation.transactionCount} transactions`;
  const fastest = observation.recommendedFees.fastestFeeSatVb;
  return {
    observation,
    item: item(
      'MEMPOOL_SPACE',
      'ONCHAIN',
      `Bitcoin mempool: ${count}${fastest === null ? '' : `; fastest fee ${fastest} sat/vB`}`,
      'https://mempool.space/',
      observedAt,
      observedAt,
      'OFFICIAL',
      'Current mempool backlog and fee recommendation snapshot; not a guaranteed confirmation time or trading signal.',
      ['mempool', 'fees', 'onchain-v1'],
    ),
  };
}

export async function fetchCoinMetricsDailyObservation(
  observedAt = Date.now(),
): Promise<{
  observation: NetworkDailyObservation;
  item: ExternalContextItem;
}> {
  const raw = jsonRecord.parse(
    await getJson(
      'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=AdrActCnt,TxCnt,FeeTotNtv&frequency=1d&page_size=2',
    ),
  );
  const rows = z.array(jsonRecord).parse(raw.data);
  const latest = rows.at(-1);
  if (!latest) throw new Error('COIN_METRICS_NO_DATA');
  const periodAt = Date.parse(String(latest.time ?? ''));
  if (!Number.isFinite(periodAt)) throw new Error('COIN_METRICS_TIME_INVALID');
  const observation = networkDailyObservationSchema.parse({
    periodAt,
    observedAt,
    activeAddressCount: numberOrNull(latest.AdrActCnt),
    transactionCount: numberOrNull(latest.TxCnt),
    totalFeesBtc: numberOrNull(latest.FeeTotNtv),
    // Community history is treated conservatively as revision-capable evidence.
    // Replay freezes the exact decision-time payload before research use.
    metricNature: 'REVISED',
  });
  const addresses =
    observation.activeAddressCount === null
      ? 'active addresses n/a'
      : `${observation.activeAddressCount} active addresses`;
  const transactions =
    observation.transactionCount === null
      ? 'transactions n/a'
      : `${observation.transactionCount} transactions`;
  return {
    observation,
    item: item(
      'COIN_METRICS_COMMUNITY',
      'ONCHAIN',
      `BTC daily network activity: ${addresses}, ${transactions}`,
      'https://charts.coinmetrics.io/network-data/',
      periodAt,
      observedAt,
      'OFFICIAL',
      observation.totalFeesBtc === null
        ? 'Coin Metrics Community daily metric snapshot.'
        : `Daily total fees ${observation.totalFeesBtc} BTC.`,
      ['network', 'activity', 'fees', 'onchain-v1'],
    ),
  };
}

function provenance(input: {
  now: number;
  mempool: MempoolObservation | null;
  networkDaily: NetworkDailyObservation | null;
}): DataProvenance[] {
  const rows: DataProvenance[] = [];
  if (input.mempool) {
    rows.push(
      buildDataProvenance({
        source: 'MEMPOOL_SPACE',
        venue: null,
        instrument: 'BTC_MEMPOOL',
        sourceEventAt: null,
        collectorReceivedAt: input.mempool.observedAt,
        generatedAt: input.now,
        metricNature: 'OBSERVED',
        coverage: 'SNAPSHOT',
        status: 'NORMAL',
        now: input.now,
      }),
    );
  }
  if (input.networkDaily) {
    rows.push(
      buildDataProvenance({
        source: 'COIN_METRICS_COMMUNITY',
        venue: null,
        instrument: 'BTC_NETWORK_DAILY',
        // The metric period is carried separately. It is not labeled as
        // transport/event latency because daily history may later be revised.
        sourceEventAt: null,
        collectorReceivedAt: input.networkDaily.observedAt,
        generatedAt: input.now,
        metricNature: 'REVISED',
        coverage: 'SNAPSHOT',
        status: 'NORMAL',
        now: input.now,
      }),
    );
  }
  return rows;
}

export function buildOnchainIntelligenceV1(input: {
  now: number;
  mempool: MempoolObservation | null;
  networkDaily: NetworkDailyObservation | null;
}): OnchainIntelligenceV1 | null {
  if (!input.mempool && !input.networkDaily) return null;
  return onchainIntelligenceV1Schema.parse({
    version: ONCHAIN_INTELLIGENCE_VERSION,
    generatedAt: input.now,
    objectiveOnly: true,
    role: 'BACKGROUND_REGIME_ONLY',
    mempool: input.mempool,
    networkDaily: input.networkDaily,
    health: {
      mempoolCollectionAgeMs:
        input.mempool === null
          ? null
          : Math.max(0, Math.trunc(input.now - input.mempool.observedAt)),
      networkDailyCollectionAgeMs:
        input.networkDaily === null
          ? null
          : Math.max(0, Math.trunc(input.now - input.networkDaily.observedAt)),
      networkDailyPeriodAgeMs:
        input.networkDaily === null
          ? null
          : Math.max(0, Math.trunc(input.now - input.networkDaily.periodAt)),
    },
    provenance: provenance(input),
  });
}
''')

write('tests/unit/onchain-provider-foundation.test.ts', r'''import { describe, expect, it } from 'vitest';

import { buildOnchainIntelligenceV1 } from '../../src/main/external/onchain-v1';
import { estimatedLiquidationLevelSchema } from '../../src/main/external/provider-contracts';
import {
  mempoolObservationSchema,
  networkDailyObservationSchema,
} from '../../src/shared/onchain-intelligence';

describe('on-chain V1 and provider boundaries', () => {
  it('keeps mempool observed and daily network evidence revision-aware and background-only', () => {
    const now = Date.UTC(2026, 7, 17, 0, 0, 0);
    const mempool = mempoolObservationSchema.parse({
      observedAt: now - 5_000,
      transactionCount: 123_456,
      virtualSizeBytes: 222_000_000,
      totalFeeSats: null,
      recommendedFees: {
        fastestFeeSatVb: 8,
        halfHourFeeSatVb: 6,
        hourFeeSatVb: 5,
        economyFeeSatVb: null,
        minimumFeeSatVb: 1,
      },
    });
    const networkDaily = networkDailyObservationSchema.parse({
      periodAt: now - 24 * 60 * 60_000,
      observedAt: now - 60_000,
      activeAddressCount: 700_000,
      transactionCount: null,
      totalFeesBtc: 3.25,
      metricNature: 'REVISED',
    });
    const result = buildOnchainIntelligenceV1({ now, mempool, networkDaily });

    expect(result?.version).toBe('onchain-v1');
    expect(result?.objectiveOnly).toBe(true);
    expect(result?.role).toBe('BACKGROUND_REGIME_ONLY');
    expect(result?.mempool?.totalFeeSats).toBeNull();
    expect(result?.networkDaily?.transactionCount).toBeNull();
    expect(result?.health.mempoolCollectionAgeMs).toBe(5_000);
    expect(result?.health.networkDailyCollectionAgeMs).toBe(60_000);
    expect(result?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'MEMPOOL_SPACE',
          metricNature: 'OBSERVED',
          coverage: 'SNAPSHOT',
        }),
        expect.objectContaining({
          source: 'COIN_METRICS_COMMUNITY',
          metricNature: 'REVISED',
          coverage: 'SNAPSHOT',
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /longSignal|shortSignal|buySignal|sellSignal|bullishScore|bearishScore|entryRecommendation/i,
    );
  });

  it('returns no structured on-chain context until at least one source exists', () => {
    expect(
      buildOnchainIntelligenceV1({ now: 1_000, mempool: null, networkDaily: null }),
    ).toBeNull();
  });

  it('forces estimated liquidation providers to remain explicitly estimated', () => {
    const valid = estimatedLiquidationLevelSchema.parse({
      price: 100_000,
      estimatedLongLiquidationNotionalUsd: 5_000_000,
      estimatedShortLiquidationNotionalUsd: null,
      metricNature: 'ESTIMATED',
      coverage: 'UNKNOWN',
    });
    expect(valid.metricNature).toBe('ESTIMATED');
    expect(
      estimatedLiquidationLevelSchema.safeParse({
        ...valid,
        observedLongLiquidationNotionalUsd: 5_000_000,
      }).success,
    ).toBe(false);
  });
});
''')

# Contracts and live service integration.
replace_once(
    'src/shared/contracts.ts',
    "import type { DeribitOptionsIntelligenceV2 } from './options-intelligence';",
    "import type { DeribitOptionsIntelligenceV2 } from './options-intelligence';\nimport type { OnchainIntelligenceV1 } from './onchain-intelligence';",
)
replace_once(
    'src/shared/contracts.ts',
    "  optionsV2: DeribitOptionsIntelligenceV2 | null;\n}",
    "  optionsV2: DeribitOptionsIntelligenceV2 | null;\n  onchainV1: OnchainIntelligenceV1 | null;\n}",
)
replace_once(
    'src/main/external/service.ts',
    "import type { DeribitOptionsIntelligenceV2 } from '../../shared/options-intelligence';",
    "import type { DeribitOptionsIntelligenceV2 } from '../../shared/options-intelligence';\nimport type {\n  MempoolObservation,\n  NetworkDailyObservation,\n} from '../../shared/onchain-intelligence';\nimport {\n  buildOnchainIntelligenceV1,\n  fetchCoinMetricsDailyObservation,\n  fetchMempoolObservation,\n} from './onchain-v1';",
)
replace_once(
    'src/main/external/service.ts',
    "  private deribitOptionsV2: DeribitOptionsIntelligenceV2 | null = null;",
    "  private deribitOptionsV2: DeribitOptionsIntelligenceV2 | null = null;\n  private mempoolObservation: MempoolObservation | null = null;\n  private networkDailyObservation: NetworkDailyObservation | null = null;",
)
replace_once(
    'src/main/external/service.ts',
    "      optionsV2: this.deribitOptionsV2,\n    };",
    "      optionsV2: this.deribitOptionsV2,\n      onchainV1: buildOnchainIntelligenceV1({\n        now,\n        mempool: this.mempoolObservation,\n        networkDaily: this.networkDailyObservation,\n      }),\n    };",
)
replace_once(
    'src/main/external/service.ts',
    "      } else if (source === 'MEMPOOL_SPACE')\n        records = await sourceAdapters.mempool();\n      else if (source === 'COIN_METRICS_COMMUNITY')\n        records = await sourceAdapters.coinMetrics();",
    "      } else if (source === 'MEMPOOL_SPACE') {\n        const collected = await fetchMempoolObservation();\n        this.mempoolObservation = collected.observation;\n        records = [collected.item];\n      } else if (source === 'COIN_METRICS_COMMUNITY') {\n        const collected = await fetchCoinMetricsDailyObservation();\n        this.networkDailyObservation = collected.observation;\n        records = [collected.item];\n      }",
)

# Worker upload compatibility and Context Router exposure.
replace_once(
    'worker/src/index.ts',
    "    optionsV2: z.unknown().nullable().optional(),\n  })",
    "    optionsV2: z.unknown().nullable().optional(),\n    onchainV1: z.unknown().nullable().optional(),\n  })",
)
replace_once(
    'worker/src/phase20-context-router.ts',
    "    optionsV2: unknown;\n    selectedItems:",
    "    optionsV2: unknown;\n    onchainV1: unknown;\n    selectedItems:",
)
replace_once(
    'worker/src/phase20-context-router.ts',
    "    optionsAvailable: boolean;\n    btcDecisionGateQuality:",
    "    optionsAvailable: boolean;\n    onchainAvailable: boolean;\n    btcDecisionGateQuality:",
)
replace_once(
    'worker/src/phase20-context-router.ts',
    "  if (asRecord(externalRoot?.optionsV2)) sourceSet.add('DERIBIT_OPTIONS_V2');",
    "  if (asRecord(externalRoot?.optionsV2)) sourceSet.add('DERIBIT_OPTIONS_V2');\n  if (asRecord(externalRoot?.onchainV1)) sourceSet.add('ONCHAIN_V1');",
)
replace_once(
    'worker/src/phase20-context-router.ts',
    "      optionsV2: externalRoot?.optionsV2 ?? null,\n      selectedItems,",
    "      optionsV2: externalRoot?.optionsV2 ?? null,\n      onchainV1: externalRoot?.onchainV1 ?? null,\n      selectedItems,",
)
replace_once(
    'worker/src/phase20-context-router.ts',
    "      optionsAvailable: asRecord(externalRoot?.optionsV2) !== null,\n      btcDecisionGateQuality:",
    "      optionsAvailable: asRecord(externalRoot?.optionsV2) !== null,\n      onchainAvailable: asRecord(externalRoot?.onchainV1) !== null,\n      btcDecisionGateQuality:",
)

# OpenAPI 5.8.0 + structured OnchainV1 schema.
openapi_path = ROOT / 'worker/openapi/openapi.json'
openapi = json.loads(openapi_path.read_text(encoding='utf-8'))
openapi['info']['version'] = '5.8.0'
schemas = openapi['components']['schemas']
schemas['OnchainV1'] = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['version', 'generatedAt', 'objectiveOnly', 'role', 'mempool', 'networkDaily', 'health', 'provenance'],
    'properties': {
        'version': {'type': 'string', 'const': 'onchain-v1'},
        'generatedAt': {'type': 'integer'},
        'objectiveOnly': {'type': 'boolean', 'const': True},
        'role': {'type': 'string', 'const': 'BACKGROUND_REGIME_ONLY'},
        'mempool': {
            'oneOf': [
                {
                    'type': 'object', 'additionalProperties': False,
                    'required': ['observedAt', 'transactionCount', 'virtualSizeBytes', 'totalFeeSats', 'recommendedFees'],
                    'properties': {
                        'observedAt': {'type': 'integer'},
                        'transactionCount': {'type': ['integer', 'null']},
                        'virtualSizeBytes': {'type': ['integer', 'null']},
                        'totalFeeSats': {'type': ['number', 'null']},
                        'recommendedFees': {'type': 'object', 'additionalProperties': True},
                    },
                },
                {'type': 'null'},
            ]
        },
        'networkDaily': {
            'oneOf': [
                {
                    'type': 'object', 'additionalProperties': False,
                    'required': ['periodAt', 'observedAt', 'activeAddressCount', 'transactionCount', 'totalFeesBtc', 'metricNature'],
                    'properties': {
                        'periodAt': {'type': 'integer'},
                        'observedAt': {'type': 'integer'},
                        'activeAddressCount': {'type': ['number', 'null']},
                        'transactionCount': {'type': ['number', 'null']},
                        'totalFeesBtc': {'type': ['number', 'null']},
                        'metricNature': {'type': 'string', 'const': 'REVISED'},
                    },
                },
                {'type': 'null'},
            ]
        },
        'health': {'type': 'object', 'additionalProperties': True},
        'provenance': {'type': 'array', 'items': {'$ref': '#/components/schemas/DataProvenance'}},
    },
    'description': 'Objective BTC on-chain background/regime evidence. Mempool is an observed snapshot; Coin Metrics daily history is treated as revision-capable and frozen in replay. Never a scalp trigger, entry gate, or directional signal.'
}
external_schema = schemas.get('ExternalContext')
if not external_schema or 'properties' not in external_schema:
    raise SystemExit('ExternalContext schema missing')
external_schema['properties']['onchainV1'] = {
    'oneOf': [{'$ref': '#/components/schemas/OnchainV1'}, {'type': 'null'}]
}
decision_schema = schemas.get('DecisionContext')
if not decision_schema or 'properties' not in decision_schema:
    raise SystemExit('DecisionContext schema missing')
decision_external = decision_schema['properties'].get('external')
if not isinstance(decision_external, dict):
    raise SystemExit('DecisionContext.external missing')
if 'properties' in decision_external:
    decision_external['properties']['onchainV1'] = {
        'oneOf': [{'$ref': '#/components/schemas/OnchainV1'}, {'type': 'null'}]
    }
else:
    decision_external['description'] = (
        str(decision_external.get('description', '')) +
        ' Includes onchainV1 objective background/regime evidence when available.'
    ).strip()
openapi_path.write_text(json.dumps(openapi, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

# OpenAPI tests.
replace_once(
    'tests/unit/worker.openapi.test.ts',
    "      DeribitOptionsV2: {\n        additionalProperties: boolean;\n        required: string[];\n        properties: { version: { const: string }; objectiveOnly: { const: boolean } };\n      };",
    "      DeribitOptionsV2: {\n        additionalProperties: boolean;\n        required: string[];\n        properties: { version: { const: string }; objectiveOnly: { const: boolean } };\n      };\n      OnchainV1: {\n        additionalProperties: boolean;\n        required: string[];\n        properties: {\n          version: { const: string };\n          objectiveOnly: { const: boolean };\n          role: { const: string };\n        };\n      };",
)
replace_once(
    'tests/unit/worker.openapi.test.ts',
    "    expect(json.info.version).toBe('5.7.0');",
    "    expect(json.info.version).toBe('5.8.0');",
)
replace_once(
    'tests/unit/worker.openapi.test.ts',
    "    expect(\n      json.components.schemas.DeribitOptionsV2.properties.objectiveOnly.const,\n    ).toBe(true);",
    "    expect(\n      json.components.schemas.DeribitOptionsV2.properties.objectiveOnly.const,\n    ).toBe(true);\n    expect(json.components.schemas.OnchainV1.additionalProperties).toBe(false);\n    expect(json.components.schemas.OnchainV1.required).toContain('networkDaily');\n    expect(json.components.schemas.OnchainV1.properties.version.const).toBe(\n      'onchain-v1',\n    );\n    expect(json.components.schemas.OnchainV1.properties.objectiveOnly.const).toBe(\n      true,\n    );\n    expect(json.components.schemas.OnchainV1.properties.role.const).toBe(\n      'BACKGROUND_REGIME_ONLY',\n    );",
)

# GPT instructions: compact explicit boundary; shrink prose only if needed.
instructions_path = ROOT / 'worker/openapi/GPT_INSTRUCTIONS.md'
instructions = instructions_path.read_text(encoding='utf-8')
anchor = '- `external.optionsV2`: DVOL·ATM IV·term·25Δ skew·put/call OI·volume. 보조증거이며 방향/목표가 신호가 아니다.'
addition = anchor + '\n- `external.onchainV1`: mempool OBSERVED + daily network REVISED. background/regime 전용이며 scalp trigger/gate 금지.'
if anchor not in instructions:
    raise SystemExit('GPT options anchor missing')
instructions = instructions.replace(anchor, addition, 1)
shortenings = [
    ('- `positionManagement`: 현재 포지션의 price-R, stop/target 거리, 보호주문 coverage, MFE/MAE 등 결정론적 관리 telemetry. 이것만으로 HOLD/EXIT를 자동 결정하지 않는다.', '- `positionManagement`: price-R, stop/target 거리, 보호주문 coverage, MFE/MAE 관리 telemetry. 이것만으로 HOLD/EXIT를 자동 결정하지 않는다.'),
    ('- fallback을 호출했더라도 서로 다른 snapshot의 값을 섞어 하나의 현재 상태처럼 만들지 않는다. 계획 검증에는 실제 분석에 사용한 최신 snapshotId를 사용한다.', '- fallback에서도 서로 다른 snapshot 값을 섞지 않는다. 계획 검증은 실제 분석의 최신 snapshotId를 사용한다.'),
    ('- `cryptoMarket=null` 또는 불완전하면 cross-asset confirmation을 만들지 않는다. 보조근거가 없음을 인정하고 BTC gate와 남은 필수 evidence가 허용하는 범위에서만 판단한다.', '- `cryptoMarket=null`/불완전이면 cross-asset confirmation을 만들지 말고 BTC gate와 남은 필수 evidence 범위에서만 판단한다.'),
]
for old, new in shortenings:
    if len(instructions) <= 7480:
        break
    instructions = instructions.replace(old, new, 1)
if len(instructions) > 7500:
    raise SystemExit(f'GPT instructions still too long: {len(instructions)}')
instructions_path.write_text(instructions, encoding='utf-8', newline='\n')

print('On-chain V1 + provider foundation staged')
