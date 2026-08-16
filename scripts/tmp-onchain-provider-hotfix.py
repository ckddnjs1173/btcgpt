from pathlib import Path

p = Path('scripts/tmp-onchain-provider-foundation.py')
s = p.read_text(encoding='utf-8')
s = s.replace(
    '"      DeribitOptionsV2: {\\n        additionalProperties: boolean;\\n        required: string[];\\n        properties: { version: { const: string }; objectiveOnly: { const: boolean } };\\n      };",',
    '"      DeribitOptionsV2: {\\n        additionalProperties: boolean;\\n        required: string[];\\n        properties: {\\n          version: { const: string };\\n          objectiveOnly: { const: boolean };\\n        };\\n      };",',
)
s = s.replace(
    '"      DeribitOptionsV2: {\\n        additionalProperties: boolean;\\n        required: string[];\\n        properties: { version: { const: string }; objectiveOnly: { const: boolean } };\\n      };\\n      OnchainV1:',
    '"      DeribitOptionsV2: {\\n        additionalProperties: boolean;\\n        required: string[];\\n        properties: {\\n          version: { const: string };\\n          objectiveOnly: { const: boolean };\\n        };\\n      };\\n      OnchainV1:',
)
s = s.replace(
    "addition = anchor + '\\n- `external.onchainV1`: mempool OBSERVED + daily network REVISED. background/regime 전용이며 scalp trigger/gate 금지.'",
    "addition = anchor + '\\n- `external.onchainV1`: mempool OBSERVED + network REVISED. 배경 전용; trigger/gate 금지.'",
)
s = s.replace(
    "  const periodAt = Date.parse(String(latest.time ?? ''));",
    "  const periodText =\\n    typeof latest.time === 'string' || typeof latest.time === 'number'\\n      ? String(latest.time)\\n      : '';\\n  const periodAt = Date.parse(periodText);",
)
p.write_text(s, encoding='utf-8', newline='\n')
