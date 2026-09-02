import { describe, expect, it } from 'vitest';
import { classifyOutcome, decideStrategy, type PriorAttempt } from '../regeneration';
import type { DetectedFinding } from '../rules';

const finding = (over: Partial<DetectedFinding> = {}): DetectedFinding => ({
  identityId: 'a', findingType: 'IDENTITY_DRIFT', severity: 'MEDIUM',
  startMs: 0, endMs: 1500, confidence: 0.7, evidence: {}, ...over,
});

const ctx = (over: Partial<Parameters<typeof decideStrategy>[0]> = {}) => ({
  findings: [finding()], priorAttempts: [] as PriorAttempt[], attemptCount: 1,
  segmentDurationMs: 10000, lastModelId: 'm1', lastConditioningStrength: 0.6,
  failingIdentityIds: ['a'], ...over,
});

describe('재생성 전략 사다리 (§11)', () => {
  it('경미한 DRIFT는 1단계 conditioning 상향 + seed 변경', () => {
    const d = decideStrategy(ctx());
    expect(d.strategy.step).toBe(1);
    expect(d.strategy.kind).toBe('CONDITIONING_BOOST');
    expect(d.strategy.params.changeSeed).toBe(true);
    expect(d.strategy.params.conditioningStrength).toBeGreaterThan(0.6);
  });

  it('BLEND는 레퍼런스 세트 교체(2단계)부터 시작한다', () => {
    const d = decideStrategy(ctx({ findings: [finding({ findingType: 'IDENTITY_BLEND' })] }));
    expect(d.strategy.kind).toBe('REFERENCE_SWAP');
  });

  it('SWAP은 세그먼트 재분할(3단계)부터 시작한다', () => {
    const d = decideStrategy(ctx({ findings: [finding({ findingType: 'IDENTITY_SWAP' })] }));
    expect(d.strategy.kind).toBe('SEGMENT_SPLIT');
  });

  it('장시간 DRIFT는 conditioning으로 해결되지 않으므로 재분할로 간다', () => {
    const d = decideStrategy(ctx({ findings: [finding({ startMs: 0, endMs: 6000 })], segmentDurationMs: 10000 }));
    expect(d.strategy.step).toBe(3);
  });

  it('동일 전략 재시도를 금지한다 (§5.1 무한 루프 방지)', () => {
    const prior: PriorAttempt[] = [{ strategy: { step: 1, kind: 'CONDITIONING_BOOST' }, outcome: 'WORSE', scoreAfter: 0.7 }];
    const d = decideStrategy(ctx({ priorAttempts: prior, attemptCount: 2 }));
    expect(d.strategy.step).not.toBe(1);
  });

  it('반복되는 SWAP/BLEND는 4단계 모델 재라우팅으로 올라간다', () => {
    const prior: PriorAttempt[] = [
      { strategy: { step: 2, kind: 'REFERENCE_SWAP' }, outcome: 'WORSE', scoreAfter: 0.7 },
      { strategy: { step: 3, kind: 'SEGMENT_SPLIT' }, outcome: 'IMPROVED', scoreAfter: 0.8 },
    ];
    const d = decideStrategy(ctx({ findings: [finding({ findingType: 'IDENTITY_SWAP' })], priorAttempts: prior, attemptCount: 2 }));
    expect(d.strategy.kind).toBe('MODEL_REROUTE');
    expect(d.strategy.params.excludeModelIds).toEqual(['m1']);
  });

  it('연속 2회 NO_CHANGE면 즉시 MANUAL_REVIEW로 승격한다 (§5.1)', () => {
    const prior: PriorAttempt[] = [
      { strategy: { step: 1, kind: 'CONDITIONING_BOOST' }, outcome: 'NO_CHANGE', scoreAfter: 0.7 },
      { strategy: { step: 2, kind: 'REFERENCE_SWAP' }, outcome: 'NO_CHANGE', scoreAfter: 0.7 },
    ];
    const d = decideStrategy(ctx({ priorAttempts: prior, attemptCount: 2 }));
    expect(d.escalate).toBe(true);
    expect(d.strategy.kind).toBe('MANUAL_REVIEW');
  });

  it('MAX_REGEN 소진 시 MANUAL_REVIEW (CREZ-QC-002)', () => {
    const prior: PriorAttempt[] = [
      { strategy: { step: 1, kind: 'CONDITIONING_BOOST' }, outcome: 'IMPROVED', scoreAfter: 0.8 },
      { strategy: { step: 2, kind: 'REFERENCE_SWAP' }, outcome: 'WORSE', scoreAfter: 0.75 },
      { strategy: { step: 3, kind: 'SEGMENT_SPLIT' }, outcome: 'IMPROVED', scoreAfter: 0.82 },
    ];
    const d = decideStrategy(ctx({ priorAttempts: prior, attemptCount: 3 }));
    expect(d.escalate).toBe(true);
  });

  it('결과 분류는 개선 폭이 미미하면 NO_CHANGE', () => {
    expect(classifyOutcome(0.8, 0.9)).toBe('IMPROVED');
    expect(classifyOutcome(0.8, 0.805)).toBe('NO_CHANGE');
    expect(classifyOutcome(0.8, 0.7)).toBe('WORSE');
  });
});
