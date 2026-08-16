from pathlib import Path

p = Path('worker/src/phase16-eval.ts')
text = p.read_text(encoding='utf-8')
old = """  } satisfies Record<HorizonKey, HorizonScore>;

  const score = {
    evaluatorVersion: EVALUATOR_VERSION,
    scoreStatus: 'FINAL',
    scoringBasis: 'RELAY_MARK_PRICE',"""
new = """  } satisfies Record<Exclude<HorizonKey, '1m' | '3m'>, HorizonScore>;

  const score = {
    evaluatorVersion: run.evaluatorVersion,
    scoreStatus: 'FINAL',
    scoringBasis: 'RELAY_MARK_PRICE',"""
if old not in text:
    raise SystemExit('legacy score block not found')
text = text.replace(old, new, 1)
p.write_text(text, encoding='utf-8')

p = Path('tests/unit/worker.openapi.test.ts')
text = p.read_text(encoding='utf-8')
text = text.replace("expect(json.info.version).toBe('5.4.0');", "expect(json.info.version).toBe('5.5.0');", 1)
text = text.replace(
    """          marketGeneratedAt: { description?: string };
        };
      };""",
    """          marketGeneratedAt: { description?: string };
          triggerContract?: unknown;
        };
      };""",
    1,
)
text = text.replace(
    """      PositionAdjustmentResponse: {
        additionalProperties: boolean;
        required: string[];
      };""",
    """      PositionAdjustmentResponse: {
        additionalProperties: boolean;
        required: string[];
      };
      StructuredTriggerContract: {
        additionalProperties: boolean;
        required: string[];
      };""",
    1,
)
anchor = """    expect(
      json.components.schemas.DecisionRecord.properties.marketGeneratedAt
        .description,
    ).toContain('Decision Context');"""
addition = anchor + """
    expect(
      json.components.schemas.DecisionRecord.properties.triggerContract,
    ).toBeDefined();
    expect(
      json.components.schemas.StructuredTriggerContract.additionalProperties,
    ).toBe(false);
    expect(json.components.schemas.StructuredTriggerContract.required).toContain(
      'sourceSnapshotId',
    );"""
if anchor not in text:
    raise SystemExit('OpenAPI test anchor not found')
text = text.replace(anchor, addition, 1)
p.write_text(text, encoding='utf-8')
