import type { IdentityMetrics, QcThresholds, ScoreWeights } from '@crez/contracts';

/**
 * §10 Identity Consistency 점수 체계.
 * 가중치·임계값은 인자로 주입받는다 — 코드에 하드코딩하지 않는다(DB ruleset).
 */

/** motion_consistency는 소스 안무가 없으면 null이다. 그 경우 가중치를 재분배한다. */
export function compositeScore(m: IdentityMetrics, w: ScoreWeights): number {
  const parts: Array<[number, number]> = [
    [w.face, m.faceSimilarity],
    [w.body, m.bodySimilarity],
    [w.temporal, m.temporalConsistency],
    [w.binding, m.bindingStability],
  ];
  if (m.motionConsistency !== null) parts.push([w.motion, m.motionConsistency]);

  const totalWeight = parts.reduce((s, [weight]) => s + weight, 0);
  if (totalWeight <= 0) return 0;
  const sum = parts.reduce((s, [weight, value]) => s + weight * clamp01(value), 0);
  return round(sum / totalWeight);
}

export interface MultiPersonVerdict {
  passed: boolean;
  overallScore: number;
  minScore: number;
  maxScore: number;
  spread: number;
  /** 하한 미달 인물 — 이들이 등장하는 세그먼트만 재생성 대상 (§10.3) */
  failingIdentityIds: string[];
  reasons: string[];
}

/**
 * §10.3 다중 인물 판정.
 * 두 조건을 동시에 만족해야 합격: (1) 모든 캐스트가 하한 이상 (2) 캐스트 간 편차가 허용 범위 이내.
 */
export function judgeMultiPerson(
  perIdentity: Record<string, number>,
  th: QcThresholds,
): MultiPersonVerdict {
  const entries = Object.entries(perIdentity);
  if (entries.length === 0) {
    return { passed: false, overallScore: 0, minScore: 0, maxScore: 0, spread: 0, failingIdentityIds: [], reasons: ['no identity scored'] };
  }
  const scores = entries.map(([, v]) => v);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const spread = round(max - min);
  // 종합 점수는 캐스트 평균이 아니라 최솟값 기준 — 한 명이 무너지면 영상이 무너진다(§20 Multi-Person KPI).
  const overall = round(entries.length === 1 ? scores[0] : min);

  const failing = entries.filter(([, v]) => v < th.perIdentityMin).map(([id]) => id);
  const reasons: string[] = [];
  if (failing.length > 0) reasons.push(`perIdentityMin ${th.perIdentityMin} 미달: ${failing.length}명`);
  if (spread > th.maxSpread) reasons.push(`캐스트 간 편차 ${spread} > 허용 ${th.maxSpread}`);
  if (overall < th.overallMin) reasons.push(`종합 ${overall} < 하한 ${th.overallMin}`);

  return {
    passed: reasons.length === 0,
    overallScore: overall,
    minScore: round(min),
    maxScore: round(max),
    spread,
    failingIdentityIds: failing,
    reasons,
  };
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
