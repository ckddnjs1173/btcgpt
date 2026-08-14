# GPT Trading Intelligence — Phase 13+ 기획 확장

> 상태: Phase 13 이후의 현재 제품 방향을 정의하는 `PROJECT_SPEC.md` 확장 문서
> 기준일: 2026-08-15
> 우선순위: 현재 사용자의 명시적 지시에 따라, 이 문서는 Phase 13 이후 범위에서 `PROJECT_SPEC.md`의 충돌하는 과거 범위 제한을 대체한다.

## 1. 최상위 목표

제품의 최상위 목표는 특정 수집기 구조를 보존하는 것이 아니라 **GPT의 코인 선물 거래 판단 능력을 극대화하고 그 판단을 실제 수동 거래에 빠르고 정확하게 연결하는 것**이다.

프로그램, Custom GPT, OpenAI API, 다른 GPT 사용법, 외부 시장 데이터, 다른 거래소·다른 코인 데이터, 뉴스·거시·옵션·온체인 데이터는 모두 이 목표를 위한 수단이다.

## 2. 유지하는 안전 경계

Phase 13 이후에도 다음 경계는 유지한다.

- 실제 Binance 주문 생성·수정·취소·출금·이체를 프로그램이나 GPT Action이 수행하지 않는다.
- 현재 실제 거래 실행 대상은 사용자가 Binance에서 수동으로 실행하는 BTCUSDT USDⓈ-M perpetual이다.
- 프로그램은 자체 LONG/SHORT 추천 엔진이나 독립 전략 점수를 만들지 않는다.
- 객관 데이터, 결정론적 계산, 과거 결과·시장 유사성은 프로그램이 제공할 수 있지만 최종 시장 해석과 거래 판단은 GPT가 담당한다.
- Secret, 계정 식별자, raw private API response와 불필요한 민감 데이터를 GPT·D1·로그에 저장하지 않는다.
- 손실 포지션의 자동 물타기와 자동 주문은 구현하지 않는다.

## 3. Phase 13 이후 허용되는 확장

기존 문서의 `다른 거래소와 BTC 이외 코인`, `OpenAI API` 등의 일괄 제외는 Phase 13 이후 연구·판단 보조 범위에는 적용하지 않는다.

다음은 판단력 향상 효과가 검증될 수 있다면 허용한다.

- Coinbase, Bybit, OKX, Deribit 등 다른 시장의 공개·허용 데이터
- ETH, SOL 등 BTC 판단에 도움이 되는 다른 자산의 객관 데이터
- 뉴스, 공식 발표, 거시경제, 옵션, ETF, 온체인, 시장 심리 정보
- 실전 Custom GPT와 별도의 OpenAI API 기반 Replay/Eval 연구 도구
- 단일 GPT, Analyst/Critic, Judge 등 여러 GPT 추론 구조 실험
- 과거 시장 Replay, Historical Analog, Trading Memory

단, 새로운 외부 서비스의 유료 비용이나 새로운 계정 권한이 필요하면 실제 활성화 전에 사용자에게 비용·권한을 명확히 알린다.

## 4. 전체 아키텍처 방향

Phase 13 이후 시스템은 다음 다섯 축으로 발전한다.

1. **Market Intelligence Platform** — 실시간·외부 시장 사실을 넓게 수집하고 검증한다.
2. **Live GPT Decision System** — 현재 상황에 필요한 Context를 사용해 진입·관망·포지션 관리를 판단한다.
3. **Trading Memory** — snapshot, GPT decision, approved plan, 실제/모의 trade, outcome을 연결한다.
4. **Replay / Eval Research Platform** — 과거 시점에서 모델·프롬프트·데이터·추론 구조를 공정하게 비교한다.
5. **Slow Research Layer** — 뉴스·거시·시장 구조 연구를 실시간 단타 경로와 분리한다.

## 5. 최적화 KPI

최상위 성과 KPI는 단순 승률이 아니라 **비용 차감 Net R Expectancy**다.

동시에 다음을 분리 측정한다.

- ENTER 적중과 잘못된 ENTER
- 좋은 기회 포착률과 놓친 기회
- WAIT_TRIGGER의 trigger/invalidation/expiry 결과
- NO_TRADE 이후 forward path
- MFE / MAE
- MFE Capture Ratio
- planned entry 대비 actual entry drift
- snapshot → GPT 판단 기록 latency
- trigger → 실제 진입 latency
- 실제 fee / funding / slippage
- PAPER와 LIVE_MANUAL 성과 차이
- drawdown

## 6. Phase 13 — Decision Telemetry & Outcome Linkage

Phase 13의 목적은 새로운 전략을 추가하는 것이 아니라 **GPT가 무엇을 보고 어떤 판단을 했는지 객관적으로 남겨 이후 성능 개선을 측정할 기반을 만드는 것**이다.

### Phase 13A — GPT Decision Telemetry

구현:

- analytics-only GPT Action `recordDecision`
- D1 `decision_log`
- `decisionId`, `snapshotId`, `marketGeneratedAt` 기록
- `ENTER_NOW`, `WAIT_TRIGGER`, `NO_TRADE`, `HOLD`, `PARTIAL_EXIT`, `EXIT` 등 구조화된 결과 기록
- LONG/SHORT/NEUTRAL side
- `instructionVersion`, `contextPackVersion`, `analysisMode`
- 짧은 `reasonTags`, `counterThesisTags`
- entry/stop/targets와 trigger/invalidation 요약은 있을 때만 기록
- Worker 기록시각과 snapshot→record latency 기록
- 현재 latest snapshot과 동일한지 `CURRENT | SUPERSEDED`로 기록
- 동일 `decisionId` 재시도는 idempotent하게 처리

금지:

- chain-of-thought 저장
- 전체 GPT 대화 저장
- 사용자 개인정보 저장
- Binance 주문 또는 계정 변경
- 판단 내용에 따라 프로그램이 자체 거래 실행

완료조건:

1. 인증 없는 decision 기록은 401이다.
2. 유효한 decision은 D1에 1회 저장된다.
3. 같은 `decisionId`와 같은 payload의 재시도는 중복 row를 만들지 않는다.
4. 같은 `decisionId`의 다른 payload는 conflict로 거절한다.
5. decision은 분석한 `snapshotId`와 `marketGeneratedAt`을 반드시 가진다.
6. Worker는 snapshot이 이미 교체됐더라도 판단 기록을 버리지 않고 `SUPERSEDED`로 표시한다.
7. Action은 analytics-only이며 주문·레버리지·자산 관련 외부효과가 없다.

### Phase 13B — Local Linkage

다음 수직 단위에서 구현한다.

- 로컬 SQLite decision mirror 또는 bounded sync
- `decisionId → planId → tradeId` 연결
- 최초 WAIT → 재분석 → ENTER와 같은 계보를 위한 `parentDecisionId`
- 승인되지 않은 WAIT/NO_TRADE도 outcome 추적 대상에 유지
- PAPER/LIVE_MANUAL 성과를 별도 집계

Phase 13B 전에는 `recordDecision`을 성과 통계로 직접 해석하지 않는다.

## 7. 이후 Phase 방향

- Phase 14: MFE/MAE, latency, planned vs actual execution telemetry
- Phase 15: objective Market Fingerprint
- Phase 16: historical Replay/Eval Lab
- Phase 17: cross-market intelligence 실험
- Phase 18: news/event intelligence 강화
- Phase 19: options intelligence 강화
- Phase 20: Context Router
- Phase 21: Trading Memory / Historical Analog
- Phase 22: adaptive GPT reasoning / critic 실험
- Phase 23: position-management intelligence
- Phase 24: live Custom GPT vs API research-agent benchmark
- Phase 25: 충분한 표본 이후 performance-aware sizing/leverage 연구

새 데이터나 GPT 구조는 가능한 한 Replay/Eval에서 baseline 대비 효과를 확인한 뒤 실전 Context로 승격한다.
