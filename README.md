# BTC Futures Assistant

Binance `BTCUSDT` USDⓈ-M 무기한 선물을 사용자가 수동으로 거래할 때 필요한 실시간 시장·계정·외부 증거를 로컬에서 수집하고,
Cloudflare Worker/D1을 통해 비공개 GPT Action에 최신 Decision Context를 제공하는
Windows 11 데스크톱 보조 프로그램입니다.

프로그램은 시장 방향이나 주문 행동을 결정하지 않습니다. GPT가 객관적 증거를 종합해 최종 거래 판단을 수행하고,
실제 진입·손절·익절 주문은 사용자가 Binance에서 직접 실행하고 체결 상태를 확인합니다.

## 운영 구성

- Electron Main에서 Binance 공개 REST/WebSocket 기반 BTCUSDT 실행 코어 수집
- ETHUSDT/SOLUSDT lead core와 고정 sentiment core, 동적 alt basket을 로컬에서 관측
- Coinbase BTC-USD/ETH-USD/SOL-USD 공개 WebSocket을 이용한 spot/perp cross-venue 참고 증거
- Deribit 공개 API 기반 BTC Options V2: DVOL, ATM IV, IV term structure, 25Δ skew, put/call OI·volume, expiry/strike OI
- mempool.space와 Coin Metrics Community 기반 `onchain-v1` background/regime 증거
- 1m, 3m, 5m, 15m, 30m, 1h, 4h 실시간/마감 캔들 및 1d, 1w 마감 참고봉 분리
- SQLite 로컬 캐시와 자동 candle gap recovery
- update ID 기반 로컬 order book 동기화와 자동 재동기화
- 15s~1h 체결 delta, 세션 CVD, 4시간 rolling CVD, OI, 포지셔닝 수집
- 객관 지표, 수수료, 슬리피지, 본전가, 위험 수량, 청산거리 계산
- 선택적 Binance signed GET 및 user data stream 읽기 전용 계정 연결
- Windows safeStorage에 Binance 및 Relay 인증정보 암호화 저장
- 2초마다 Relay용 compact snapshot을 Worker/D1에 업로드
- BTC core / 보조 시장 / 외부 evidence의 freshness·provenance를 분리하고 중요도에 따라 blocking/degraded/optional 처리
- `getDecisionSnapshot`으로 현재 판단용 compact Decision Context를 제공하고 `getLatestSnapshot`은 상세/debug fallback으로 유지
- GPT Action의 계획·포지션 조정 계산 검증과 decision telemetry / Replay / Evaluation V2 기록
- 사용자 선택 1~150배 레버리지, 기본 10배, Isolated 전용
- 사용자 승인 계획의 가격 trigger·무효화·만료를 로컬에서 감시하고 알림만 제공
- Windows 절전/복귀 후 시장·계정 스트림 재시작과 데이터 복구

## 설치 및 실행

요구사항은 Windows 11, Node.js 24 이상, npm 11 이상입니다.

```powershell
cd C:\Code\btcgpt
npm ci
npm start
```

창의 닫기 버튼은 앱을 시스템 트레이로 숨깁니다. 완전히 종료하려면
트레이 메뉴에서 `앱 종료`를 선택합니다.

## 최초 운영 설정

### Relay

운영 Worker URL:

```text
https://btc-futures-assistant-relay.btcgpt-ck1173.workers.dev
```

`secrets/cloudflare-production.json`의 `UPLOADER_WRITE_KEY`를 출력하지
않고 클립보드로 복사합니다.

```powershell
$relaySecrets = Get-Content -Raw -Encoding utf8 secrets/cloudflare-production.json | ConvertFrom-Json
$relaySecrets.UPLOADER_WRITE_KEY | Set-Clipboard
Remove-Variable relaySecrets
```

앱의 Relay URL과 업로드 키 입력란에 붙여 넣어 연결합니다. 설정은
Windows safeStorage에 저장되므로 이후 일반 실행에서도 유지됩니다. 완료 후:

```powershell
Set-Clipboard -Value ''
```

### 수수료와 슬리피지

가장 정확한 계산은 거래 권한과 출금 권한을 모두 끈 Binance Futures 읽기
전용 API 키를 앱에 연결하는 방식입니다. 앱은 현재 Binance 계정의 실제
Maker/Taker 수수료율을 우선 사용합니다.

계정을 연결하지 않으면 Binance에서 직접 확인한 본인의 Maker/Taker 요율을
소수로 입력합니다. 예를 들어 0.02%는 `0.0002`입니다. 슬리피지는 거래소가
고정 제공하는 값이 아니므로 본인의 체결 기록에 맞춰 bps 단위로 입력합니다.
초기 참고값으로 1 bps를 사용할 수 있지만 실제 체결비용으로 보장되는 값은
아닙니다.

최대 손실 USDT 또는 계정 위험 비율도 입력한 뒤 `설정 저장`을 누릅니다.
필수 비용값이 비어 있으면 앱과 Worker는 수량·손익 결과를 만들지 않습니다.

### 비공개 GPT Action

GPT Action에는 `worker/openapi/openapi.json`을 등록하고 인증을 API Key /
Bearer로 설정합니다. 인증값에는 `ACTION_READ_KEY`만 사용합니다.
`UPLOADER_WRITE_KEY`를 GPT에 입력하면 안 됩니다.

GPT Instructions에는 `worker/openapi/GPT_INSTRUCTIONS.md`의 현재 버전을
사용합니다. 현재시장 판단은 `getDecisionSnapshot`을 공식 입력으로 사용하고,
진입 계획 검증은 실제 분석에 사용한 `snapshotId`를 `validateTradePlan`에 그대로 전달합니다.
`getLatestSnapshot`은 상세 확인이나 fallback이 필요한 경우에만 사용합니다.

## Worker 재배포

D1과 두 Secret은 이미 생성되어 있습니다. Worker 코드 변경 후 기존
Cloudflare 계정에서 다음 명령만 실행합니다.

```powershell
cd C:\Code\btcgpt
npm exec wrangler -- login
npm exec wrangler -- whoami
npm exec wrangler -- d1 migrations apply btc-futures-assistant --remote
npm exec wrangler -- deploy --secrets-file secrets/cloudflare-production.json --strict
```

Secret 파일을 화면, 로그, 채팅 또는 Git에 노출하지 않습니다.

## Windows 설치파일

```powershell
npm run make
```

설치파일은 `out\make\squirrel.windows\x64` 아래 생성됩니다. 코드서명
인증서가 없으므로 Windows SmartScreen 경고가 나타날 수 있습니다.

## 데이터와 문서

SQLite DB는 Electron의 `app.getPath('userData')` 아래에 저장됩니다.
DB, 로그, 백업, `.env`, Binance 키, Relay Secret은 Git 커밋 대상이
아닙니다.

문서 우선순위는 `AGENTS.md`를 따릅니다. 기본 범위는 `docs/PROJECT_SPEC.md`,
Phase 13+ 승인 확장은 `docs/PROJECT_SPEC_PHASE13_PLUS.md`, Market Intelligence V2는
`docs/MARKET_INTELLIGENCE_V2.md`를 함께 기준으로 사용합니다. 서로 충돌하는 과거 범위 문구는
승인된 Phase 13+ 확장이 우선합니다.

## 절대 원칙

- 실제 수동 거래 대상은 Binance `BTCUSDT` USDⓈ-M perpetual입니다. 다른 심볼·거래소는 객관적 판단 보조 증거로 관측할 수 있지만 실행 대상으로 자동 승격하지 않습니다.
- 프로그램은 독자적인 LONG/SHORT, 진입 추천, 시장 방향 점수를 만들지 않습니다.
- 레버리지는 1~150배에서 사용자가 선택하며 미지정 시 10배이고, 마진은 Isolated만 지원합니다.
- 고배율을 이유로 사용자 지정 증거금·수량·명목·최대손실을 자동 확대하지 않습니다.
- 주문 생성·수정·취소, 출금, 이체 API와 자동 주문 기능을 구현하지 않습니다.
- live desktop / live Custom GPT 경로는 OpenAI API를 호출하지 않습니다. 별도 research/eval 경로는 사용자 승인과 비용 통제가 명시된 경우에만 분리해 사용할 수 있습니다.
- observed / derived / estimated / revised / point-in-time 증거를 같은 성격으로 취급하지 않습니다.
- 옵션, 온체인, 예상 청산 등 보조 증거는 단독 scalp trigger나 BTC entry gate가 아닙니다.
- Replay는 판단 당시 Decision Context를 동결하고 future outcome이나 수정된 외부 데이터를 입력으로 역류시키지 않습니다.
- 가짜 스냅샷을 운영 Worker/D1에 업로드하지 않습니다.
- API Key와 Secret을 코드, 로그, Renderer, GPT 자료, Git에 노출하지 않습니다.
- 앱 알림은 Binance에 직접 등록한 보호 손절을 대체하지 않습니다.
