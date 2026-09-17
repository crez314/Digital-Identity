/**
 * 실행 전 비용 견적 (§12.1).
 *
 * 1분 영상은 5초 구간 12개, 4분이면 48개다. 실행 버튼 한 번이 수십 건의 유료 생성을 한꺼번에
 * 제출하므로, 누르기 전에 얼마가 나가는지 알아야 하고 상한을 넘으면 멈춰야 한다.
 * 제출한 요청은 제공자가 취소를 거부할 수 있어 되돌릴 수 없다(§12.1) — 사후 정산은 방법이 없다.
 *
 * 모델이 고정돼 있지 않으면 라우터가 어느 모델을 고를지 실행 전에는 알 수 없다.
 * 그래서 단일 값이 아니라 후보 단가의 최소·최대 구간으로 답한다.
 */

export interface CostSegment {
  segmentId: string;
  segmentIndex: number;
  durationMs: number;
}

export interface SegmentCostEstimate extends CostSegment {
  min: number;
  max: number;
}

export interface RunCostEstimate {
  segmentCount: number;
  durationMs: number;
  /** 후보 단가가 하나뿐이면(모델 고정) min과 max가 같다 */
  min: number;
  max: number;
  /**
   * 모든 구간이 시도 한도를 다 쓰는 최악의 경우. 추정이 아니라 상한이다 —
   * "보통 이 정도"가 아니라 "이보다 더 나올 수는 없다"로 읽어야 한다.
   */
  worstCase: number;
  perSegment: SegmentCostEstimate[];
  /** 유료 단가를 하나도 찾지 못했다(전부 무료·자체 호스팅 모델) */
  free: boolean;
}

const round = (n: number) => Number(n.toFixed(4));

/**
 * @param rates 후보 모델의 초당 단가 목록. 모델이 고정돼 있으면 1개만 넣는다.
 * @param maxAttempt 구간당 시도 한도 (§5.1) — 최악의 경우 계산에 쓴다.
 */
export function estimateRun(
  segments: CostSegment[],
  rates: number[],
  maxAttempt: number,
): RunCostEstimate {
  const usable = rates.filter((r) => Number.isFinite(r) && r > 0);
  const minRate = usable.length > 0 ? Math.min(...usable) : 0;
  const maxRate = usable.length > 0 ? Math.max(...usable) : 0;

  const perSegment = segments.map((s) => {
    const seconds = Math.max(0, s.durationMs) / 1000;
    return { ...s, min: round(seconds * minRate), max: round(seconds * maxRate) };
  });

  const min = round(perSegment.reduce((sum, s) => sum + s.min, 0));
  const max = round(perSegment.reduce((sum, s) => sum + s.max, 0));

  return {
    segmentCount: segments.length,
    durationMs: segments.reduce((sum, s) => sum + Math.max(0, s.durationMs), 0),
    min,
    max,
    worstCase: round(max * Math.max(1, maxAttempt)),
    perSegment,
    free: usable.length === 0,
  };
}
