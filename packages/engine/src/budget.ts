/**
 * 지출 한도 판정 (§12.1).
 *
 * 생성 실행 한 번이 수십 건의 유료 요청이고, 제출한 요청은 제공자가 취소를 거부할 수 있어
 * 되돌릴 수 없다. 그래서 사후 정산이 아니라 제출 전에 막는다.
 *
 * 견적은 크레딧으로 나오고 한도는 원화다. 환산에는 단가가 필요한데 단가는 계약 정보라
 * 코드가 알 수 없다 — 모르는 동안 유료 생성을 막을지(기본값)도 정책으로 둔다.
 * 얼마가 나갈지 모르는 채로 돈을 쓰는 것보다 멈추는 편이 낫다는 판단이다.
 */

export interface SpendPolicy {
  /**
   * 월 상한(원) — **실패한 생성은 빼고** 센다. null이면 상한 없음.
   * 제공자는 실패한 요청을 과금하지 않는다고 밝히므로, 실제로 나갈 돈은 이 값으로 통제한다.
   */
  monthlyBudgetKrw: number | null;
  /**
   * 월 상한(원) — **실패한 생성까지 포함**해 센다. null이면 상한 없음.
   * 실패가 과금되지 않더라도 실패가 쏟아지면 무언가 잘못된 것이다(잘못된 레퍼런스, 제공자 장애).
   * 실패를 포함한 총량에도 천장을 두어 그런 상황에서 자동으로 멈춘다.
   */
  monthlyGrossBudgetKrw: number | null;
  /** 1 크레딧의 원화 단가. null이면 원화 환산 불가 */
  creditUnitPriceKrw: number | null;
  /** 단가를 모르는 동안 유료 생성을 막을지 */
  blockWhenUnpriced: boolean;
}

export interface BudgetInput {
  policy: SpendPolicy;
  /** 이번 달 쓴 크레딧 — 실패 제외(확정 비용 + 진행 중인 작업의 예상 비용) */
  monthToDateCredits: number;
  /** 이번 달 쓴 크레딧 — 실패 포함. 생략하면 실패를 따로 세지 않는 것으로 본다 */
  grossMonthToDateCredits?: number;
  /** 이번 실행의 견적(크레딧). 최대치를 넣는다 */
  estimateCredits: number;
}

export interface BudgetVerdict {
  /** 제출해도 되는가 */
  allowed: boolean;
  /** 막은 이유 — 통과하면 null */
  reason: 'UNPRICED' | 'OVER_BUDGET' | 'OVER_GROSS_BUDGET' | null;
  /** 사람이 읽을 설명 */
  message: string | null;
  /** 원화 환산값. 단가를 모르면 전부 null */
  monthToDateKrw: number | null;
  estimateKrw: number | null;
  remainingKrw: number | null;
  /** 이번 실행까지 더했을 때의 이번 달 총액 */
  projectedKrw: number | null;
  /** 실패 포함 기준의 같은 값들 */
  grossMonthToDateKrw: number | null;
  grossRemainingKrw: number | null;
  grossProjectedKrw: number | null;
}

const won = (n: number) => Math.round(n);
/** 한도로 쓸 수 있는 값인가 — null·NaN·Infinity는 "상한 없음"으로 본다 */
const valid = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? null : n);
const fmt = (n: number) => won(n).toLocaleString('ko-KR');

/**
 * 유료 생성이 아닌 경우(mock·자체 호스팅)는 이 검사를 부르지 않는다 —
 * 돈이 나가지 않는 실행까지 막으면 파이프라인 검증이 멈춘다.
 */
export function checkBudget(input: BudgetInput): BudgetVerdict {
  const { policy, monthToDateCredits, estimateCredits } = input;
  // 실패 집계를 넘기지 않는 호출자는 성공분만으로 판단한다(두 한도가 같은 값이 된다).
  const grossCredits = input.grossMonthToDateCredits ?? monthToDateCredits;
  const price = policy.creditUnitPriceKrw;

  if (price === null || !Number.isFinite(price) || price <= 0) {
    // 단가를 모르면 원화 상한을 적용할 방법이 없다. 막을지 통과시킬지는 정책이 정한다.
    return {
      allowed: !policy.blockWhenUnpriced,
      reason: policy.blockWhenUnpriced ? 'UNPRICED' : null,
      message: policy.blockWhenUnpriced
        ? '크레딧 단가가 설정되지 않아 원화 한도를 적용할 수 없습니다 — '
          + '지출 정책에서 1크레딧당 원화 단가를 입력하면 바로 풀립니다'
        : null,
      monthToDateKrw: null, estimateKrw: null, remainingKrw: null, projectedKrw: null,
      grossMonthToDateKrw: null, grossRemainingKrw: null, grossProjectedKrw: null,
    };
  }

  const monthToDateKrw = won(monthToDateCredits * price);
  const grossMonthToDateKrw = won(grossCredits * price);
  const estimateKrw = won(estimateCredits * price);
  const projectedKrw = monthToDateKrw + estimateKrw;
  const grossProjectedKrw = grossMonthToDateKrw + estimateKrw;

  const budget = valid(policy.monthlyBudgetKrw);
  const grossBudget = valid(policy.monthlyGrossBudgetKrw);
  const remainingKrw = budget === null ? null : won(budget - monthToDateKrw);
  const grossRemainingKrw = grossBudget === null ? null : won(grossBudget - grossMonthToDateKrw);
  const totals = {
    monthToDateKrw, estimateKrw, remainingKrw, projectedKrw,
    grossMonthToDateKrw, grossRemainingKrw, grossProjectedKrw,
  };

  // 이번 실행은 성공할 수도 실패할 수도 있으므로 두 한도 모두에 더해 본다.
  // 둘 중 하나라도 넘으면 막는다 — 먼저 걸리는 쪽을 사유로 알린다.
  if (budget !== null && projectedKrw > budget) {
    return {
      allowed: false,
      reason: 'OVER_BUDGET',
      message:
        `월 한도 ${fmt(budget)}원(실패 제외)을 넘습니다 — 이번 달 사용 ${fmt(monthToDateKrw)}원, `
        + `이번 실행 ${fmt(estimateKrw)}원, 남은 한도 ${fmt(Math.max(0, remainingKrw ?? 0))}원. `
        + '구간을 줄이거나 한도를 조정하세요',
      ...totals,
    };
  }

  if (grossBudget !== null && grossProjectedKrw > grossBudget) {
    return {
      allowed: false,
      reason: 'OVER_GROSS_BUDGET',
      message:
        `실패 포함 월 한도 ${fmt(grossBudget)}원을 넘습니다 — 실패 포함 사용 ${fmt(grossMonthToDateKrw)}원`
        + `(그중 실패 ${fmt(grossMonthToDateKrw - monthToDateKrw)}원), 이번 실행 ${fmt(estimateKrw)}원, `
        + `남은 한도 ${fmt(Math.max(0, grossRemainingKrw ?? 0))}원. `
        + '실패가 계속되면 원인을 먼저 확인하세요',
      ...totals,
    };
  }

  return { allowed: true, reason: null, message: null, ...totals };
}

/** 이번 달의 시작 시각 — 사용량 집계 기준 */
export function monthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
