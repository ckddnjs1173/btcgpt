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
p.write_text(s, encoding='utf-8', newline='\n')
