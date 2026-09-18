import { describe, expect, it } from 'vitest';
import { checkBudget, monthStart, type SpendPolicy } from '../budget';

/**
 * 제출한 요청은 제공자가 취소를 거부할 수 있어 되돌릴 수 없다(§12.1).
 * 한도는 사후 정산이 아니라 제출 전에 걸어야 의미가 있다.
 */
const policy = (over: Partial<SpendPolicy> = {}): SpendPolicy => ({
  monthlyBudgetKrw: 100_000,
  creditUnitPriceKrw: 250,
  blockWhenUnpriced: true,
  ...over,
});

describe('월 지출 한도', () => {
  it('한도 안이면 통과하고 남은 금액을 알려준다', () => {
    // 3.75크레딧 사용 = 937원, 이번 실행 15크레딧 = 3,750원
    const v = checkBudget({ policy: policy(), monthToDateCredits: 3.75, estimateCredits: 15 });
    expect(v.allowed).toBe(true);
    expect(v.monthToDateKrw).toBe(938);
    expect(v.estimateKrw).toBe(3750);
    expect(v.remainingKrw).toBe(99_062);
  });

  it('이번 실행까지 더해 한도를 넘으면 막는다 — 이미 쓴 돈만 보면 늦는다', () => {
    const v = checkBudget({ policy: policy(), monthToDateCredits: 300, estimateCredits: 120 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('OVER_BUDGET');
    expect(v.projectedKrw).toBe(105_000);
  });

  it('딱 맞으면 통과한다', () => {
    const v = checkBudget({ policy: policy(), monthToDateCredits: 0, estimateCredits: 400 });
    expect(v.allowed).toBe(true);
    expect(v.projectedKrw).toBe(100_000);
  });

  it('막을 때 얼마가 남았는지 말해 준다 — 구간을 얼마나 줄일지 판단해야 한다', () => {
    const v = checkBudget({ policy: policy(), monthToDateCredits: 396, estimateCredits: 15 });
    expect(v.message).toContain('99,000원');   // 이번 달 사용
    expect(v.message).toContain('1,000원');    // 남은 한도
  });

  it('단가를 모르면 기본적으로 유료 생성을 막는다', () => {
    const v = checkBudget({
      policy: policy({ creditUnitPriceKrw: null }), monthToDateCredits: 0, estimateCredits: 1,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('UNPRICED');
    expect(v.message).toContain('단가');
  });

  it('단가를 몰라도 통과시키도록 정할 수 있다', () => {
    const v = checkBudget({
      policy: policy({ creditUnitPriceKrw: null, blockWhenUnpriced: false }),
      monthToDateCredits: 0, estimateCredits: 1,
    });
    expect(v.allowed).toBe(true);
    expect(v.estimateKrw).toBeNull();
  });

  it('단가가 0이나 음수면 설정되지 않은 것으로 본다', () => {
    expect(checkBudget({
      policy: policy({ creditUnitPriceKrw: 0 }), monthToDateCredits: 0, estimateCredits: 1,
    }).reason).toBe('UNPRICED');
  });

  it('금액 상한이 없으면 환산만 하고 통과시킨다', () => {
    const v = checkBudget({
      policy: policy({ monthlyBudgetKrw: null }), monthToDateCredits: 1000, estimateCredits: 1000,
    });
    expect(v.allowed).toBe(true);
    expect(v.remainingKrw).toBeNull();
    expect(v.projectedKrw).toBe(500_000);
  });
});

describe('집계 기준 달', () => {
  it('그 달의 1일 0시부터 센다', () => {
    expect(monthStart(new Date('2026-09-18T12:34:56Z')).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});
