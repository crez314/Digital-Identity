import { snapDuration } from '@crez/shared';

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
 * 후보 모델 하나. 제공자가 고정 길이만 받으면 `durations`에 허용 값을 넣는다 —
 * 과금은 구간 길이가 아니라 **제공자에 보내는 길이**로 매겨지기 때문이다.
 */
export interface CostCandidate {
  code: string;
  costPerSecond: number;
  /** 제공자가 받는 길이(초). 비어 있으면 구간 길이를 그대로 보낸다고 본다 */
  durations?: number[] | null;
}

/**
 * @param candidates 후보 모델. 모델이 고정돼 있으면 1개만 넣는다.
 * @param maxAttempt 구간당 시도 한도 (§5.1) — 최악의 경우 계산에 쓴다.
 */
export function estimateRun(
  segments: CostSegment[],
  candidates: CostCandidate[],
  maxAttempt: number,
): RunCostEstimate {
  const usable = candidates.filter((c) => Number.isFinite(c.costPerSecond) && c.costPerSecond > 0);

  const perSegment = segments.map((s) => {
    const seconds = Math.max(0, s.durationMs) / 1000;
    // 모델마다 보내는 길이가 달라질 수 있으므로 비용은 모델별로 계산한 뒤 최소·최대를 고른다.
    // 구간 길이에 단가만 곱하면 4초 구간이 5초로 스냅되는 모델에서 25% 모자라게 나온다.
    const costs = usable.map((c) => snapDuration(c.durations, seconds) * c.costPerSecond);
    return {
      ...s,
      min: round(costs.length > 0 ? Math.min(...costs) : 0),
      max: round(costs.length > 0 ? Math.max(...costs) : 0),
    };
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
