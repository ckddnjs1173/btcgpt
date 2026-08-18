import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const instructionsPath = path.join(
  process.cwd(),
  'worker',
  'openapi',
  'GPT_INSTRUCTIONS.md',
);
const instructions = fs.readFileSync(instructionsPath, 'utf8');

describe('GPT Policy v2 contract', () => {
  it('keeps GPT policy telemetry separate from the Decision Context version', () => {
    expect(instructions).toContain('# BTC Futures Assistant — GPT Policy v2');
    expect(instructions).toContain('instructionVersion=gpt-policy-v2');
    expect(instructions).toContain('contextPackVersion=decision-context-v1');
    expect(instructions).not.toContain('instructionVersion=decision-context-v1');
  });

  it('keeps evidence precedence and independent-confirmation rules explicit', () => {
    expect(instructions).toContain('gate·freshness·실제 position/lifecycle');
    expect(instructions).toContain(
      'BTC core: 확정 가격구조, order flow/CVD, 동기화 호가, OI/funding, timeframe',
    );
    expect(instructions).toContain(
      '낮은 단계가 높은 단계의 명확한 반대근거를 단독으로 뒤집지 못한다',
    );
    expect(instructions).toContain(
      '같은 source/동일 계산의 중복은 독립 확인으로 세지 않으며',
    );
  });

  it('keeps ENTER, WAIT, NO_TRADE and DATA_BLOCKED behavior distinct', () => {
    expect(instructions).toContain(
      '`ENTER_NOW`: gate 통과 + 단일 방향의 BTC 핵심구조 + 최소 1개 독립적인 현재 확인근거',
    );
    expect(instructions).toContain(
      '`WAIT_TRIGGER`: 방향 thesis는 있으나 핵심 확인 하나가 아직 부족하고',
    );
    expect(instructions).toContain(
      '한쪽 방향의 구체적 가격 trigger와 invalidation을 지금 정의할 수 있을 때만',
    );
    expect(instructions).toContain(
      '`NO_TRADE`: 양방향 근거가 팽팽함, 구조가 불명확함',
    );
    expect(instructions).toContain(
      '`DATA_BLOCKED`: gate가 분석 자체를 막을 때만',
    );
    expect(instructions).toContain('거래를 만들기 위해 WAIT을 남발하지 않는다');
  });

  it('keeps WAIT triggers as reanalysis requests instead of entry permission', () => {
    expect(instructions).toContain('GPT-authored `triggerContract` 1개만');
    expect(instructions).toContain(
      '`TRIGGERED`는 진입허가가 아니라 fresh `getDecisionSnapshot` 재분석 요구',
    );
  });

  it('keeps confidence descriptive rather than an action shortcut', () => {
    expect(instructions).toContain('숫자 확률 대신 `NONE|LOW|MEDIUM|HIGH`');
    expect(instructions).toContain(
      'confidence가 낮다고 자동 WAIT, 높다고 자동 ENTER하지 않는다',
    );
    expect(instructions).toContain(
      '보조시장 합의만으로 HIGH 금지',
    );
  });

  it('keeps position management anchored to protection and invalidation', () => {
    expect(instructions).toContain(
      '보호주문 coverage → 원래 invalidation/현재 구조 붕괴 여부 → 현재 flow/price response → price-R/MFE/MAE',
    );
    expect(instructions).toContain(
      '수익 중이라는 이유만으로 stop/TP를 자동 이동하지 않는다',
    );
    expect(instructions).toContain('손실 포지션 물타기 금지');
  });
});
