import json
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'missing anchor: {label}')
    return text.replace(old, new, 1)


# Local decision-context contract: add crossVenue and bump only the local envelope.
p = Path('src/shared/decision-context.ts')
text = p.read_text(encoding='utf-8')
if "./cross-venue-intelligence" not in text:
    text = replace_once(
        text,
        "import { z } from 'zod';\n\n",
        "import { z } from 'zod';\n\nimport {\n  crossVenueIntelligenceSchema,\n  type CrossVenueIntelligence,\n} from './cross-venue-intelligence';\n",
        'cross-venue import',
    )
text = replace_once(
    text,
    "export const LOCAL_MARKET_INTELLIGENCE_VERSION = 'local-market-v1' as const;",
    "export const LOCAL_MARKET_INTELLIGENCE_VERSION = 'local-market-v2' as const;",
    'local market version',
)
text = replace_once(
    text,
    "    altMarket: compactAltMarketSchema.nullable(),\n    evidenceHealth: z.array(evidenceHealthSchema).max(128),",
    "    altMarket: compactAltMarketSchema.nullable(),\n    crossVenue: crossVenueIntelligenceSchema.nullable(),\n    evidenceHealth: z.array(evidenceHealthSchema).max(128),",
    'local market schema',
)
text = replace_once(
    text,
    "  altMarket: AltMarketIntelligence | null;\n  evidenceHealth: LocalMarketIntelligence['evidenceHealth'];",
    "  altMarket: AltMarketIntelligence | null;\n  crossVenue?: CrossVenueIntelligence | null;\n  evidenceHealth: LocalMarketIntelligence['evidenceHealth'];",
    'builder input',
)
text = replace_once(
    text,
    "    ...(input.altMarket?.provenance ?? []),\n  ]",
    "    ...(input.altMarket?.provenance ?? []),\n    ...(input.crossVenue?.provenance ?? []),\n  ]",
    'provenance merge',
)
text = replace_once(
    text,
    "    evidenceHealth: input.evidenceHealth,\n    provenance,",
    "    crossVenue: input.crossVenue ?? null,\n    evidenceHealth: input.evidenceHealth,\n    provenance,",
    'builder output',
)
p.write_text(text, encoding='utf-8')

# Strict OpenAPI contract for local cross-venue evidence.
p = Path('worker/openapi/openapi.json')
doc = json.loads(p.read_text(encoding='utf-8'))
doc['info']['version'] = '5.6.0'
schemas = doc['components']['schemas']
nullable_number = {'type': ['number', 'null']}
compact_returns = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['1m', '3m', '5m'],
    'properties': {
        '1m': nullable_number,
        '3m': nullable_number,
        '5m': nullable_number,
    },
}
asset_schema = {
    'type': 'object',
    'additionalProperties': False,
    'required': [
        'asset', 'generatedAt', 'coinbaseProductId', 'binanceInstrument',
        'quoteCurrencyMismatch', 'coinbaseSpot', 'binancePerp', 'derived',
    ],
    'properties': {
        'asset': {'type': 'string', 'enum': ['BTC', 'ETH', 'SOL']},
        'generatedAt': {'type': 'integer', 'minimum': 0},
        'coinbaseProductId': {'type': 'string', 'enum': ['BTC-USD', 'ETH-USD', 'SOL-USD']},
        'binanceInstrument': {'type': 'string', 'enum': ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']},
        'quoteCurrencyMismatch': {'type': 'boolean', 'const': True},
        'coinbaseSpot': {
            'type': 'object', 'additionalProperties': False,
            'required': [
                'lastPrice', 'bidPrice', 'askPrice', 'spreadBps', 'returnsBps',
                'normalizedTakerDelta1m', 'normalizedTakerDelta5m',
                'depthImbalance20', 'microPrice',
            ],
            'properties': {
                'lastPrice': nullable_number,
                'bidPrice': nullable_number,
                'askPrice': nullable_number,
                'spreadBps': nullable_number,
                'returnsBps': compact_returns,
                'normalizedTakerDelta1m': nullable_number,
                'normalizedTakerDelta5m': nullable_number,
                'depthImbalance20': nullable_number,
                'microPrice': nullable_number,
            },
        },
        'binancePerp': {
            'type': 'object', 'additionalProperties': False,
            'required': ['markPrice', 'returnsBps', 'normalizedTakerDelta1m', 'normalizedTakerDelta5m'],
            'properties': {
                'markPrice': nullable_number,
                'returnsBps': compact_returns,
                'normalizedTakerDelta1m': nullable_number,
                'normalizedTakerDelta5m': nullable_number,
            },
        },
        'derived': {
            'type': 'object', 'additionalProperties': False,
            'required': [
                'perpSpotReferenceSpreadBps', 'returnDifferenceBps',
                'normalizedTakerDeltaDifference1m', 'normalizedTakerDeltaDifference5m',
            ],
            'properties': {
                'perpSpotReferenceSpreadBps': nullable_number,
                'returnDifferenceBps': compact_returns,
                'normalizedTakerDeltaDifference1m': nullable_number,
                'normalizedTakerDeltaDifference5m': nullable_number,
            },
        },
    },
}
schemas['CrossVenueIntelligence'] = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['version', 'generatedAt', 'objectiveOnly', 'interpretationBoundary', 'assets', 'provenance'],
    'properties': {
        'version': {'type': 'string', 'enum': ['cross-venue-v1']},
        'generatedAt': {'type': 'integer', 'minimum': 0},
        'objectiveOnly': {'type': 'boolean', 'const': True},
        'interpretationBoundary': {
            'type': 'string',
            'enum': ['BINANCE_USDT_PERP_VS_COINBASE_USD_SPOT_REFERENCE_ONLY'],
        },
        'assets': {
            'type': 'object',
            'additionalProperties': False,
            'required': ['BTC', 'ETH', 'SOL'],
            'properties': {
                'BTC': {'oneOf': [asset_schema, {'type': 'null'}]},
                'ETH': {'oneOf': [asset_schema, {'type': 'null'}]},
                'SOL': {'oneOf': [asset_schema, {'type': 'null'}]},
            },
        },
        'provenance': {
            'type': 'array',
            'items': {'$ref': '#/components/schemas/DataProvenance'},
            'maxItems': 24,
        },
    },
}
local = schemas['LocalMarketIntelligence']
local['required'] = [
    'version', 'generatedAt', 'objectiveOnly', 'leadCore', 'altMarket',
    'crossVenue', 'evidenceHealth', 'provenance',
]
local['properties']['version']['enum'] = ['local-market-v2']
local['properties']['crossVenue'] = {
    'oneOf': [
        {'$ref': '#/components/schemas/CrossVenueIntelligence'},
        {'type': 'null'},
    ]
}
p.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

# GPT interpretation boundary.
p = Path('worker/openapi/GPT_INSTRUCTIONS.md')
text = p.read_text(encoding='utf-8')
text = replace_once(
    text,
    '- `cryptoMarket`: 로컬 ETH/SOL lead-core + 고정/Dynamic alt market의 객관 관측·파생통계. 방향 신호가 아니다.',
    '- `cryptoMarket`: 로컬 ETH/SOL·alt·`crossVenue`의 객관 관측. `perpSpotReferenceSpreadBps`는 USD/USDT 차이 포함 참고값이며 arbitrage/방향 신호가 아니다.',
    'GPT cryptoMarket line',
)
text = replace_once(
    text,
    '- `crossMarket`: Binance/Coinbase BTC/ETH/SOL 등 기존 cross-market corroboration. 상대강도/spread는 자동 방향 신호가 아니다.',
    '- `crossMarket`: Worker 저빈도 corroboration. `cryptoMarket.crossVenue`와 중복되면 더 신선한 provenance/age를 우선하고 독립 확인으로 이중계산하지 않는다.',
    'GPT crossMarket line',
)
p.write_text(text, encoding='utf-8')

# OpenAPI tests.
p = Path('tests/unit/worker.openapi.test.ts')
text = p.read_text(encoding='utf-8')
text = replace_once(text, "expect(json.info.version).toBe('5.5.0');", "expect(json.info.version).toBe('5.6.0');", 'OpenAPI version test')
text = replace_once(
    text,
    "      StructuredTriggerContract: {\n        additionalProperties: boolean;\n        required: string[];\n      };",
    "      StructuredTriggerContract: {\n        additionalProperties: boolean;\n        required: string[];\n      };\n      LocalMarketIntelligence: {\n        additionalProperties: boolean;\n        required: string[];\n        properties: { version: { enum: string[] } };\n      };\n      CrossVenueIntelligence: {\n        additionalProperties: boolean;\n        required: string[];\n      };",
    'OpenAPI test interface',
)
anchor = "    expect(\n      json.components.schemas.StructuredTriggerContract.required,\n    ).toContain('sourceSnapshotId');"
text = replace_once(
    text,
    anchor,
    anchor + "\n    expect(\n      json.components.schemas.LocalMarketIntelligence.properties.version.enum,\n    ).toEqual(['local-market-v2']);\n    expect(json.components.schemas.LocalMarketIntelligence.required).toContain(\n      'crossVenue',\n    );\n    expect(\n      json.components.schemas.CrossVenueIntelligence.additionalProperties,\n    ).toBe(false);\n    expect(json.components.schemas.CrossVenueIntelligence.required).toContain(\n      'interpretationBoundary',\n    );",
    'OpenAPI assertions',
)
p.write_text(text, encoding='utf-8')

# Decision transport tests follow the local envelope version.
p = Path('tests/unit/decision-context-v1.test.ts')
text = p.read_text(encoding='utf-8').replace("'local-market-v1'", "'local-market-v2'")
p.write_text(text, encoding='utf-8')
