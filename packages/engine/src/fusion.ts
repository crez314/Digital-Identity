/**
 * CREZ Identity Consistency Score — 복합 점수 융합. 자체 구현.
 *
 * **외부 모델 점수를 그대로 내보내지 않는다.** AdaFace든 SFace든 인코더가 주는 것은
 * 코사인 유사도 하나뿐이며, 그것은 "이 프레임의 얼굴이 기준과 얼마나 닮았는가"만 말한다.
 * CREZ 점수는 다음 다섯 축을 결합해 "이 영상이 그 인물의 영상으로 성립하는가"를 답한다.
 *
 *   FaceIdentity            기준 대비 얼굴 일치도      (reference-to-frame)
 *   BodyIdentity            기준 대비 신체 일치도      (reference-to-frame)
 *   TemporalFaceConsistency 얼굴의 시간축 안정성        (frame-to-frame)
 *   TemporalBodyConsistency 신체의 시간축 안정성        (frame-to-frame)
 *   IdentityDriftPenalty    드리프트 구간의 심각도·지속 (감점)
 *
 * 앞 넷은 가중합, 마지막은 **감점**으로 작용한다. 가중합에 섞지 않는 이유는
 * 드리프트가 "낮은 점수"가 아니라 "결격"에 가깝기 때문이다. 평균이 높아도
 * 치명적 구간이 있으면 사용할 수 없는 영상이며, 감점 구조라야 그것이 드러난다.
 *
 * 모든 가중치·정규화 파라미터는 ruleset(DB)에서 주입된다. 코드에 상수를 두지 않는다.
 */
import type { Normalizer } from './normalize';
import type { SeriesStats } from './stats';

export interface FusionWeights {
  faceIdentity: number;
  bodyIdentity: number;
  temporalFace: number;
  temporalBody: number;
  driftPenalty: number;
}

export interface DriftSummary {
  driftFrames: number;
  totalFrames: number;
  maxSeverity: number;
  averageSeverity: number;
  maxDurationSec: number;
}

export interface FusionInput {
  faceStats: SeriesStats;
  bodyStats: SeriesStats | null;
  /** 시간 일관성 0~1 (1 = 완전 안정) */
  temporalFace: number;
  temporalBody: number | null;
  drift: DriftSummary;
}

export interface FusionBreakdown {
  faceIdentityScore: number;
  bodyIdentityScore: number | null;
  temporalFaceScore: number;
  temporalBodyScore: number | null;
  baseScore: number;
  driftPenalty: number;
  finalScore: number;
  /** 각 축이 최종 점수에 기여한 정도 — 감사·설명용 */
  contributions: Record<string, number>;
  /** 신체 신호 부재로 가중치를 재분배했는가 */
  bodySignalAvailable: boolean;
}

/**
 * 하위 백분위를 섞어 대표 일치도를 만든다.
 * 평균만 쓰면 짧고 치명적인 붕괴가 묻히므로, p05를 함께 반영한다.
 */
export function representativeIdentity(stats: SeriesStats, tailWeight: number): number {
  const w = Math.max(0, Math.min(1, tailWeight));
  return stats.mean * (1 - w) + stats.p05 * w;
}

export function fuse(
  input: FusionInput,
  weights: FusionWeights,
  normalizeFace: Normalizer,
  normalizeBody: Normalizer,
  opts: { tailWeight?: number; penaltyScale?: number } = {},
): FusionBreakdown {
  const tailWeight = opts.tailWeight ?? 0.3;
  const penaltyScale = opts.penaltyScale ?? 100;

  const faceIdentityScore = normalizeFace(representativeIdentity(input.faceStats, tailWeight));
  const bodyIdentityScore = input.bodyStats
    ? normalizeBody(representativeIdentity(input.bodyStats, tailWeight))
    : null;

  const temporalFaceScore = clamp100(input.temporalFace * 100);
  const temporalBodyScore = input.temporalBody === null ? null : clamp100(input.temporalBody * 100);

  // 신체 신호가 없으면 그 가중치를 같은 modality(얼굴)로 넘긴다.
  // 0으로 두면 신체 미검출이 그대로 감점이 되어 후면 촬영 영상이 부당하게 낮아진다.
  const hasBody = bodyIdentityScore !== null;
  const hasTemporalBody = temporalBodyScore !== null;
  const wFace = hasBody ? weights.faceIdentity : weights.faceIdentity + weights.bodyIdentity;
  const wBody = hasBody ? weights.bodyIdentity : 0;
  const wTFace = hasTemporalBody ? weights.temporalFace : weights.temporalFace + weights.temporalBody;
  const wTBody = hasTemporalBody ? weights.temporalBody : 0;

  const contributions = {
    faceIdentity: round(wFace * faceIdentityScore),
    bodyIdentity: round(wBody * (bodyIdentityScore ?? 0)),
    temporalFace: round(wTFace * temporalFaceScore),
    temporalBody: round(wTBody * (temporalBodyScore ?? 0)),
  };

  const totalWeight = wFace + wBody + wTFace + wTBody;
  const baseScore = totalWeight > 0
    ? round(Object.values(contributions).reduce((a, b) => a + b, 0) / totalWeight)
    : 0;

  // 감점 — 드리프트 비율과 심각도를 함께 본다.
  // 비율만 쓰면 짧지만 치명적인 구간이, 심각도만 쓰면 넓지만 경미한 열화가 묻힌다.
  const ratio = input.drift.totalFrames > 0
    ? input.drift.driftFrames / input.drift.totalFrames
    : 0;
  const penaltyFactor = Math.max(0, Math.min(1,
    ratio * input.drift.averageSeverity + input.drift.maxSeverity * 0.5 * (ratio > 0 ? 1 : 0),
  ));
  const driftPenalty = round(weights.driftPenalty * penaltyFactor * penaltyScale);

  const finalScore = clamp100(baseScore - driftPenalty);

  return {
    faceIdentityScore, bodyIdentityScore, temporalFaceScore, temporalBodyScore,
    baseScore, driftPenalty, finalScore, contributions,
    bodySignalAvailable: hasBody,
  };
}

function clamp100(v: number): number {
  return round(Math.max(0, Math.min(100, v)), 2);
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
