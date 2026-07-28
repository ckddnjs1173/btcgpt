# BTC Futures Assistant

BTCUSDT USDⓈ-M 무기한 선물의 실시간 시장 데이터를 로컬에서 수집하고,
Cloudflare Worker/D1을 통해 비공개 GPT Action에 최신 스냅샷을 제공하는
Windows 11 데스크톱 보조 프로그램입니다.

프로그램과 GPT는 주문을 생성·수정·취소하지 않습니다. 실제 진입, 손절,
익절 주문은 사용자가 Binance에서 직접 실행하고 체결 상태를 확인합니다.

## 운영 구성

- Electron Main에서 Binance 공개 REST/WebSocket 수집
- 5m, 15m, 1h, 4h 마감 캔들과 진행 캔들 분리
- SQLite 로컬 캐시와 자동 gap recovery
- 객관 지표, 수수료, 슬리피지, 본전가, 위험 수량 계산
- 선택적 Binance signed GET 읽기 전용 계정 연결
- Windows safeStorage에 Binance 및 Relay 인증정보 암호화 저장
- 5초마다 실제 로컬 스냅샷을 Worker/D1에 업로드
- GPT Action의 최신 스냅샷 조회와 거래 계획 계산 검증
- stale 또는 불완전 데이터의 분석 차단
- 10배 격리, BTCUSDT 전용, 사용자 수동 주문 정책 고정

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

프로젝트의 유일한 기준 문서는 `docs/PROJECT_SPEC.md`입니다.

## 절대 원칙

- BTCUSDT 이외 심볼을 추가하지 않습니다.
- 레버리지는 10배 격리로 고정합니다.
- 주문 API와 자동 주문 기능을 구현하지 않습니다.
- OpenAI API를 호출하지 않습니다.
- 가짜 스냅샷을 운영 Worker/D1에 업로드하지 않습니다.
- API Key와 Secret을 코드, 로그, Renderer, GPT 자료, Git에 노출하지 않습니다.
- 앱 알림은 Binance에 직접 등록한 보호 손절을 대체하지 않습니다.
