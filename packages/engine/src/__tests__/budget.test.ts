import { describe, expect, it } from 'vitest';
import { checkBudget, monthStart, type SpendPolicy } from '../budget';

/**
 * 제출한 요청은 제공자가 취소를 거부할 수 있어 되돌릴 수 없다(§12.1).
 * 한도는 사후 정산이 아니라 제출 전에 걸어야 의미가 있다.
 */
const policy = (over: Partial<SpendPolicy> = {}): SpendPolicy => ({
  monthlyBudgetKrw: 100_000,
  monthlyGrossBudgetKrw: null,
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

/**
 * 한도는 둘이다. 실패한 생성은 제공자가 과금하지 않으므로 실제 지출(실패 제외)로 통제하고,
 * 실패가 쏟아지는 상황(잘못된 레퍼런스·제공자 장애)을 잡기 위해 실패 포함 총량에도 천장을 둔다.
 */
describe('실패 포함 한도', () => {
  const two = (over: Partial<SpendPolicy> = {}) =>
    policy({ monthlyBudgetKrw: 300_000, monthlyGrossBudgetKrw: 500_000, creditUnitPriceKrw: 1_000, ...over });

  it('실패분은 실패 제외 한도를 깎지 않는다', () => {
    // 성공 100크레딧(10만원) + 실패 150크레딧(15만원) = 실패 포함 25만원
    const v = checkBudget({
      policy: two(), monthToDateCredits: 100, grossMonthToDateCredits: 250, estimateCredits: 100,
    });
    expect(v.allowed).toBe(true);
    expect(v.monthToDateKrw).toBe(100_000);
    expect(v.grossMonthToDateKrw).toBe(250_000);
    expect(v.remainingKrw).toBe(200_000);
    expect(v.grossRemainingKrw).toBe(250_000);
  });

  it('실패 제외 한도를 넘으면 OVER_BUDGET으로 막는다', () => {
    const v = checkBudget({
      policy: two(), monthToDateCredits: 290, grossMonthToDateCredits: 290, estimateCredits: 20,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('OVER_BUDGET');
  });

  it('성공분은 여유가 있어도 실패가 쌓여 총량을 넘으면 막는다', () => {
    // 성공 50크레딧(5만원)뿐이지만 실패까지 490크레딧(49만원) — 이번 실행 20크레딧이면 51만원
    const v = checkBudget({
      policy: two(), monthToDateCredits: 50, grossMonthToDateCredits: 490, estimateCredits: 20,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('OVER_GROSS_BUDGET');
    expect(v.message).toContain('실패 포함');
    expect(v.message).toContain('440,000원');   // 그중 실패
  });

  it('실패 포함 한도가 없으면 실패 제외 한도만 본다', () => {
    const v = checkBudget({
      policy: two({ monthlyGrossBudgetKrw: null }),
      monthToDateCredits: 50, grossMonthToDateCredits: 5_000, estimateCredits: 20,
    });
    expect(v.allowed).toBe(true);
    expect(v.grossRemainingKrw).toBeNull();
  });

  it('실패 집계를 넘기지 않으면 성공분만으로 판단한다 — 기존 호출자와 같은 결과', () => {
    const v = checkBudget({ policy: two(), monthToDateCredits: 100, estimateCredits: 100 });
    expect(v.allowed).toBe(true);
    expect(v.grossMonthToDateKrw).toBe(100_000);
  });
});
