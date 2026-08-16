from pathlib import Path

p = Path('scripts/tmp-deribit-options-v2.py')
s = p.read_text(encoding='utf-8')
s = s.replace(
    "new_line = '- `external`: 뉴스/매크로/온체인 + `optionsV2`(DVOL·ATM IV·term·25Δ skew·put/call OI/volume). 옵션은 보조증거이며 방향/목표가 신호가 아니다.'",
    "new_line = '- `external.optionsV2`: DVOL·ATM IV·term·25Δ skew·put/call OI·volume. 보조증거이며 방향/목표가 신호가 아니다.'",
)
s = s.replace(
    "    ('프로그램의 crypto-market, cross-market, memory, reasoning policy, management telemetry는 증거/라우팅일 뿐 LONG/SHORT 신호가 아니다.', 'crypto-market, cross-market, memory, reasoning policy, management telemetry는 증거/라우팅이며 LONG/SHORT 신호가 아니다.'),\n]",
    "    ('프로그램의 crypto-market, cross-market, memory, reasoning policy, management telemetry는 증거/라우팅일 뿐 LONG/SHORT 신호가 아니다.', 'crypto-market, cross-market, memory, reasoning policy, management telemetry는 증거/라우팅이며 LONG/SHORT 신호가 아니다.'),\n    ('`getDecisionSnapshot`은 BTC core와 보조 시장정보를 같은 decision snapshot anchor로 묶은 공식 compact live context다.', '`getDecisionSnapshot`은 BTC core와 보조 시장정보를 같은 snapshot anchor로 묶는다.'),\n    ('- `crossMarket`: 저빈도 corroboration. `cryptoMarket.crossVenue`와 겹치면 더 신선한 provenance/age를 우선하고 이중계산하지 않는다.', '- `crossMarket`: 저빈도 corroboration. `cryptoMarket.crossVenue`와 겹치면 더 신선한 provenance/age 우선, 이중계산 금지.'),\n]",
)
s = s.replace(
    "  const observedAt = latest[0];\n  const value = latest[4];",
    "  const observedAt = latest[0] ?? Number.NaN;\n  const value = latest[4] ?? Number.NaN;",
)
s = s.replace("if \"expect(context.version).toBe('decision-context-v1');\" in text and 'optionsV2' not in text:", "if False:")
p.write_text(s, encoding='utf-8', newline='\n')
