# Evaluation V2

## 목적

Evaluation V2는 GPT 판단을 하나의 임의 전략 점수로 축약하지 않고, 결정 종류별로 서로 다른 사후 품질 벡터를 측정한다. 프로그램은 이 결과를 이용해 LONG/SHORT 또는 자동 승격 결정을 만들지 않는다.

## 시간 구간

사후 시장 경로는 다음 구간으로 평가한다.

- 1m
- 3m
- 5m
- 15m
- 30m
- 60m

기존 `eval-v1` 실험은 기존 5m/15m/30m/60m 계약을 그대로 유지한다. 새 실험은 `eval-v2`를 명시한다.

## 가격 경로

`replay_case_outcomes.price_path_json`은 decision 시점 이후 relay에서 관찰한 mark price를 `[ageMs, markPrice]` 형태로 최대 60분까지 압축 저장한다.

초기 샘플링 간격:

- 0~5분: 최소 5초
- 5~15분: 최소 15초
- 15~60분: 최소 30초

이 경로는 **relay에서 샘플링된 mark price**이며 거래소의 tick-by-tick 체결 경로가 아니다. 따라서 TP/SL 순서가 샘플 사이에서 발생했는지는 확정할 수 없다. 알 수 없는 순서를 추측하거나 유리한 방향으로 보정하지 않는다.

기존 replay case처럼 `price_path_json`이 없는 사례는 plan-aware 평가를 만들지 않고 `available=false`로 표시한다.

## ENTER_NOW

ENTER_NOW는 방향 성과와 계획 품질을 함께 측정한다.

- 1m/3m/5m/15m/30m/60m signed return
- favorable/adverse excursion
- planned stop distance 기준 MFE R / MAE R
- TP1~TP3 hit time
- stop hit time
- TP-before-SL / SL-before-TP 순서
- time-to-MFE / time-to-MAE
- 최초 60초 adverse excursion
- 실제 연결 거래가 있으면 realized Net R와 entry drift

방향 정확도는 ENTER_NOW에만 적용한다.

## WAIT_TRIGGER

WAIT_TRIGGER는 GPT가 사용자에게 제시하고 `recordDecision`에도 동일하게 저장한 structured `triggerContract`를 replay한다.

측정 항목:

- trigger 발생 여부와 time-to-trigger
- confirmation window 유지 여부
- trigger 전 invalidation 여부
- expiry without trigger
- trigger 당시 chase bps와 `maxChaseBps` 초과 여부
- trigger 이후 15분 favorable/adverse excursion

WAIT_TRIGGER에는 방향 점수나 임의 scalar penalty를 붙이지 않는다.

## NO_TRADE / DATA_BLOCKED

- NO_TRADE는 향후 opportunity vector를 기술적으로 표시한다. `-1점` 같은 임의 penalty를 사용하지 않는다.
- DATA_BLOCKED는 발생 건수와 데이터 품질 문제를 추적하지만 시장 성과 점수로 환산하지 않는다.

## 포지션 관리

`HOLD | PARTIAL_EXIT | EXIT | MOVE_STOP | CHANGE_TP`는 신규진입 방향정답률과 분리한다.

각 판단 이후 1m~60m의:

- favorable move
- adverse move
- time-to-favorable/adverse
- 연결 가능한 경우 realized Net R / MFE capture

등을 기술적으로 비교한다. 관리 판단도 하나의 scalar strategy score로 축약하지 않는다.

## Structured trigger telemetry

`DecisionRecord.triggerContract`는 WAIT_TRIGGER에서만 허용된다.

- `authoredBy=GPT`
- `triggerContract.decisionId == decisionId`
- `triggerContract.sourceSnapshotId == snapshotId`

이 계약은 GPT가 사용자에게 제시한 것과 동일해야 한다. 프로그램은 trigger를 생성하지 않는다.

## 승격 정책

Evaluation V2 결과는 연구 증거다. 모델·Instructions·context 변경을 자동으로 live에 승격하지 않는다.

후보 변경은 frozen replay와 실제 decision-linked trade 결과를 함께 검토하고 `REJECT | MORE_DATA | LIVE_CANDIDATE`의 수동 검토 절차를 거친다.
