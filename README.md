# BTC Futures Assistant

BTCUSDT USDⓈ-M 무기한 선물을 Windows 11에서 감시하기 위한 로컬
데스크톱 보조 프로그램입니다. 주문은 사용자가 바이낸스에서 직접 실행하며,
이 프로그램은 자동 주문을 생성·수정·취소하지 않습니다.

현재 구현 단계는 **Phase 0 — 골격·기술검증**입니다. 바이낸스 시세, 거래
신호, 계정 조회는 아직 연결되지 않았습니다.

## Phase 0에서 확인할 수 있는 기능

- Electron Main / Preload / React Renderer 분리
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- 허용된 IPC 함수만 노출하는 `contextBridge`
- Node 24 내장 `node:sqlite` 로컬 저장·조회
- Windows 데스크톱 알림
- 시스템 트레이와 창 숨기기·복원
- 클립보드 복사
- 허용목록 기반 ChatGPT 외부 브라우저 열기
- ESLint, TypeScript, Vitest, Prettier, Electron Forge 패키징

## 개발 환경

- Windows 11
- Node.js 24 이상
- npm 11 이상
- Git

Node와 npm 버전 확인:

```powershell
node --version
npm --version
git --version
```

## 설치 및 실행

프로젝트 폴더에서:

```powershell
npm ci
npm start
```

처음 실행한 뒤 화면의 네 가지 테스트를 직접 확인합니다.

1. Windows 알림
2. 클립보드 복사
3. ChatGPT 외부 브라우저 열기
4. SQLite 저장·조회

창의 닫기 버튼을 누르면 앱은 종료되지 않고 시스템 트레이로 숨겨집니다.
완전히 종료하려면 트레이 메뉴에서 `앱 종료`를 선택합니다.

## 검증 명령

```powershell
npm run lint
npm run typecheck
npm test
npm run test:sqlite
npm run format:check
npm run build
```

한 번에 핵심 검사를 실행하려면:

```powershell
npm run check
```

## Windows 설치파일 만들기

```powershell
npm run make
```

결과물은 `out\make` 아래에 생성됩니다. MVP는 코드서명 인증서를 사용하지
않으므로 Windows SmartScreen 경고가 나타날 수 있습니다.

## 데이터 위치

SQLite DB는 Electron의 `app.getPath('userData')` 아래 `database` 폴더에
저장됩니다. DB, 로그, 백업, `.env`와 인증정보는 Git 커밋 대상이 아닙니다.

## 개발 문서

- 최우선 명세: `docs/PROJECT_SPEC.md`
- 현재 상태: `docs/CURRENT_STATE.md`
- 다음 작업 인수인계: `docs/HANDOFF.md`
- 기술 결정: `docs/DECISIONS.md`
- 보안 원칙: `docs/SECURITY.md`

Phase를 시작하기 전에 위 문서를 읽고, 종료할 때 현재 상태와 인수인계 문서를
실제 결과에 맞게 갱신합니다.

## 절대 원칙

- BTCUSDT 이외 심볼을 추가하지 않습니다.
- 레버리지는 10배 고정입니다.
- 자동주문과 주문 API를 구현하지 않습니다.
- OpenAI API를 호출하지 않습니다.
- API Key와 Secret을 코드, 로그, Renderer, GPT 자료, Git에 노출하지
  않습니다.
- 앱 알람은 거래소에 등록한 보호 손절을 대체하지 않습니다.
