import json
from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'missing block in {path}: {old[:100]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# Local decision-context contract -> v2 with local crossVenue evidence.
p = Path('src/shared/decision-context.ts')
text = p.read_text(encoding='utf-8')
if "./cross-venue-intelligence" not in text:
    text = text.replace(
        "import { z } from 'zod';\n\n",
        "import { z } from 'zod';\n\nimport {\n  crossVenueIntelligenceSchema,\n  type CrossVenueIntelligence,\n} from './cross-venue-intelligence';\n",
        1,
    )
text = text.replace(
    "export const LOCAL_MARKET_INTELLIGENCE_VERSION = 'local-market-v1' as const;",
    "export const LOCAL_MARKET_INTELLIGENCE_VERSION = 'local-market-v2' as const;",
    1,
)
text = text.replace(
    """    altMarket: compactAltMarketSchema.nullable(),
    evidenceHealth: z.array(evidenceHealthSchema).max(128),""",
    """    altMarket: compactAltMarketSchema.nullable(),
    crossVenue: crossVenueIntelligenceSchema.nullable(),
    evidenceHealth: z.array(evidenceHealthSchema).max(128),""",
    1,
)
text = text.replace(
    """  altMarket?: AltMarketIntelligence | null;
  evidenceHealth: EvidenceHealth[];
}): LocalMarketIntelligence {""",
    """  altMarket?: AltMarketIntelligence | null;
  crossVenue?: CrossVenueIntelligence | null;
  evidenceHealth: EvidenceHealth[];
}): LocalMarketIntelligence {""",
    1,
)
text = text.replace(
    """    ...(input.altMarket?.provenance ?? []),
  ]""",
    """    ...(input.altMarket?.provenance ?? []),
    ...(input.crossVenue?.provenance ?? []),
  ]""",
    1,
)
text = text.replace(
    """    altMarket: input.altMarket ? compactAltMarket(input.altMarket) : null,
    evidenceHealth: input.evidenceHealth,""",
    """    altMarket: input.altMarket ? compactAltMarket(input.altMarket) : null,
    crossVenue: input.crossVenue ?? null,
    evidenceHealth: input.evidenceHealth,""",
    1,
)
p.write_text(text, encoding='utf-8')

# OpenAPI contract.
p = Path('worker/openapi/openapi.json')
doc = json.loads(p.read_text(encoding='utf-8'))
doc['info']['version'] = '5.6.0'
schemas = doc['components']['schemas']
num = {'type': ['number', 'null']}
compact_returns = {
    'type': 'object', 'additionalProperties': False,
    'required': ['1m', '3m', '5m'],
    'properties': {'1m': num, '3m': num, '5m': num},
}
coinbase_spot = {
    'type': 'object', 'additionalProperties': False,
    'required': ['lastPrice','bidPrice','askPrice','spreadBps','returnsBps','normalizedTakerDelta1m','normalizedTakerDelta5m','depthImbalance20','microPrice'],
    'properties': {
        'lastPrice': num, 'bidPrice': num, 'askPrice': num, 'spreadBps': num,
        'returnsBps': compact_returns,
        'normalizedTakerDelta1m': num, 'normalizedTakerDelta5m': num,
        'depthImbalance20': num, 'microPrice': num,
    },
}
binance_perp = {
    'type': 'object', 'additionalProperties': False,
    'required': ['markPrice','returnsBps','normalizedTakerDelta1m','normalizedTakerDelta5m'],
    'properties': {
        'markPrice': num, 'returnsBps': compact_returns,
        'normalizedTakerDelta1m': num, 'normalizedTakerDelta5m': num,
    },
}
derived = {
    'type': 'object', 'additionalProperties': False,
    'required': ['perpSpotReferenceSpreadBps','returnDifferenceBps','normalizedTakerDeltaDifference1m','normalizedTakerDeltaDifference5m'],
    'properties': {
        'perpSpotReferenceSpreadBps': num,
        'returnDifferenceBps': compact_returns,
        'normalizedTakerDeltaDifference1m': num,
        'normalizedTakerDeltaDifference5m': num,
    },
}
asset_schema = {
    'type': 'object', 'additionalProperties': False,
    'required': ['asset','generatedAt','coinbaseProductId','binanceInstrument','quoteCurrencyMismatch','coinbaseSpot','binancePerp','derived'],
    'properties': {
        'asset': {'type': 'string', 'enum': ['BTC','ETH','SOL']},
        'generatedAt': {'type': 'integer', 'minimum': 0},
        'coinbaseProductId': {'type': 'string', 'enum': ['BTC-USD','ETH-USD','SOL-USD']},
        'binanceInstrument': {'type': 'string', 'enum': ['BTCUSDT','ETHUSDT','SOLUSDT']},
        'quoteCurrencyMismatch': {'type': 'boolean', 'const': True},
        'coinbaseSpot': coinbase_spot,
        'binancePerp': binance_perp,
        'derived': derived,
    },
}
schemas['CrossVenueIntelligence'] = {
    'type': 'object', 'additionalProperties': False,
    'required': ['version','generatedAt','objectiveOnly','interpretationBoundary','assets','provenance'],
    'properties': {
        'version': {'type': 'string', 'enum': ['cross-venue-v1']},
        'generatedAt': {'type': 'integer', 'minimum': 0},
        'objectiveOnly': {'type': 'boolean', 'const': True},
        'interpretationBoundary': {'type': 'string', 'enum': ['BINANCE_USDT_PERP_VS_COINBASE_USD_SPOT_REFERENCE_ONLY']},
        'assets': {
            'type': 'object', 'additionalProperties': False,
            'required': ['BTC','ETH','SOL'],
            'properties': {
                'BTC': {'oneOf': [asset_schema, {'type': 'null'}]},
                'ETH': {'oneOf': [asset_schema, {'type': 'null'}]},
                'SOL': {'oneOf': [asset_schema, {'type': 'null'}]},
            },
        },
        'provenance': {'type': 'array', 'items': {'$ref': '#/components/schemas/DataProvenance'}, 'maxItems': 24},
    },
}
local = schemas['LocalMarketIntelligence']
local['required'] = ['version','generatedAt','objectiveOnly','leadCore','altMarket','crossVenue','evidenceHealth','provenance']
local['properties']['version']['enum'] = ['local-market-v2']
local['properties']['crossVenue'] = {'oneOf': [{'$ref': '#/components/schemas/CrossVenueIntelligence'}, {'type': 'null'}]}
p.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

# GPT interpretation boundary.
p = Path('worker/openapi/GPT_INSTRUCTIONS.md')
text = p.read_text(encoding='utf-8')
text = text.replace(
    "- `cryptoMarket`: 로컬 ETH/SOL lead-core + 고정/Dynamic alt market의 객관 관측·파생통계. 방향 신호가 아니다.",
    "- `cryptoMarket`: 로컬 ETH/SOL·alt + `crossVenue`(Coinbase BTC/ETH/SOL spot vs Binance perp)의 객관 관측. `perpSpotReferenceSpreadBps`는 USD/USDT quote 차이를 포함한 참고값이며 arbitrage/방향 신호가 아니다.",
    1,
)
text = text.replace(
    "- `crossMarket`: Binance/Coinbase BTC/ETH/SOL 등 기존 cross-market corroboration. 상대강도/spread는 자동 방향 신호가 아니다.",
    "- `crossMarket`: Worker의 저빈도/광역 corroboration. 로컬 `cryptoMarket.crossVenue`와 중복되면 더 신선한 provenance/age를 우선하고 독립 확인처럼 이중계산하지 않는다.",
    1,
)
p.write_text(text, encoding='utf-8')

# OpenAPI tests.
p = Path('tests/unit/worker.openapi.test.ts')
text = p.read_text(encoding='utf-8')
text = text.replace("expect(json.info.version).toBe('5.5.0');", "expect(json.info.version).toBe('5.6.0');", 1)
text = text.replace(
    """      StructuredTriggerContract: {
        additionalProperties: boolean;
        required: string[];
      };""",
    """      StructuredTriggerContract: {
        additionalProperties: boolean;
        required: string[];
      };
      LocalMarketIntelligence: {
        additionalProperties: boolean;
        required: string[];
        properties: { version: { enum: string[] } };
      };
      CrossVenueIntelligence: {
        additionalProperties: boolean;
        required: string[];
      };""",
    1,
)
anchor = """    expect(json.components.schemas.StructuredTriggerContract.required).toContain(
      'sourceSnapshotId',
    );"""
if anchor not in text:
    raise SystemExit('OpenAPI test anchor missing')
text = text.replace(
    anchor,
    anchor + """
    expect(
      json.components.schemas.LocalMarketIntelligence.properties.version.enum,
    ).toEqual(['local-market-v2']);
    expect(json.components.schemas.LocalMarketIntelligence.required).toContain(
      'crossVenue',
    );
    expect(
      json.components.schemas.CrossVenueIntelligence.additionalProperties,
    ).toBe(false);
    expect(json.components.schemas.CrossVenueIntelligence.required).toContain(
      'interpretationBoundary',
    );""",
    1,
)
p.write_text(text, encoding='utf-8')
