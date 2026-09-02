import { DELTA_MARGIN, TAU_ASSIGN } from '@crez/shared';

/**
 * §9.1 소스 영상 → 캐스트 매핑 판정.
 * Hungarian 전역 최적 할당 자체는 crez-ml이 계산하고, 여기서는
 * "확정할 것인가 / 운영자 확인으로 올릴 것인가"를 판정한다(§2.2 판단은 api·워커에).
 */

export interface AssignmentInput {
  trackIndex: number;
  identityId: string | null;
  similarity: number;
  runnerUpIdentityId: string | null;
  runnerUpSimilarity: number | null;
  margin: number | null;
}

export interface BindingVerdict extends AssignmentInput {
  /** τ_assign 미만이거나 δ_margin 미만이면 확정하지 않는다 */
  needsReview: boolean;
  reason: string | null;
  confidence: number;
}

export function judgeAssignments(
  assignments: AssignmentInput[],
  opts: { tauAssign?: number; deltaMargin?: number } = {},
): BindingVerdict[] {
  const tau = opts.tauAssign ?? TAU_ASSIGN;
  const delta = opts.deltaMargin ?? DELTA_MARGIN;

  return assignments.map((a) => {
    let reason: string | null = null;
    if (!a.identityId) reason = '할당된 캐스트 없음';
    else if (a.similarity < tau) reason = `최고 유사도 ${a.similarity.toFixed(3)} < τ_assign ${tau}`;
    else if (a.margin !== null && a.margin < delta) {
      reason = `1·2순위 차 ${a.margin.toFixed(3)} < δ_margin ${delta}`;
    }
    // 유사도와 margin을 함께 반영한 신뢰도
    const marginTerm = a.margin === null ? 0.5 : Math.min(1, a.margin / Math.max(delta * 2, 1e-6));
    const simTerm = Math.max(0, Math.min(1, (a.similarity - tau) / Math.max(1 - tau, 1e-6)));
    return {
      ...a,
      needsReview: reason !== null,
      reason,
      confidence: Number((0.6 * simTerm + 0.4 * marginTerm).toFixed(4)),
    };
  });
}

/** 모든 트랙이 확정되었는지 — 생성 실행 전 게이트 (CREZ-MAP-002) */
export function allConfirmed(verdicts: BindingVerdict[]): boolean {
  return verdicts.length > 0 && verdicts.every((v) => !v.needsReview);
}
