/**
 * Identity Drift Severity — CREZ 자체 구현.
 *
 * 드리프트를 true/false로 다루지 않는다. 운영자는 "문제가 있다"가 아니라
 * "얼마나 심각하고 왜 그런가"를 알아야 재생성 전략을 고를 수 있다.
 *
 * **판정 구조**
 * 네 가지 독립 신호를 각각 0~1로 정규화한 뒤 가중 결합한다.
 *   1. 기준 인물 대비 얼굴 유사도 하락폭   (reference-to-frame, face)
 *   2. 기준 인물 대비 신체 유사도 하락폭   (reference-to-frame, body)
 *   3. 직전 프레임 대비 얼굴 변화량        (frame-to-frame, face)
 *   4. 직전 프레임 대비 신체 변화량        (frame-to-frame, body)
 *
 * 1·2는 "누구인가"가 틀어진 것을, 3·4는 "같은 사람이 갑자기 변했는가"를 잡는다.
 * 둘은 다른 현상이다 — 기준과 꾸준히 다르지만 안정적인 경우(캐스팅 오류)와
 * 기준과는 맞지만 프레임마다 튀는 경우(생성 불안정)를 구분해야 한다.
 *
 * 지속시간은 severity를 증폭한다. 한 프레임의 튐과 2초간의 붕괴는 다르다.
 */

export type DriftReason =
  | 'face_similarity_drop'
  | 'body_similarity_drop'
  | 'face_temporal_instability'
  | 'body_temporal_instability'
  | 'sustained_duration';

export interface DriftSignals {
  /** 기준 대비 얼굴 유사도 (0~1) */
  faceSimilarity: number;
  /** 기준 대비 신체 유사도 (0~1). 신체 신호가 없으면 null */
  bodySimilarity: number | null;
  /** 직전 프레임 대비 얼굴 변화량 (1 - cos) */
  faceDelta: number | null;
  /** 직전 프레임 대비 신체 변화량 (1 - cos) */
  bodyDelta: number | null;
  /** 조건이 유지된 시간(초) */
  durationSec: number;
}

export interface SeverityThresholds {
  faceSimilarityThreshold: number;
  bodySimilarityThreshold: number;
  faceTemporalDeltaThreshold: number;
  bodyTemporalDeltaThreshold: number;
  /** 이 시간(초)을 넘으면 지속 가중이 최대가 된다 */
  durationSaturationSec: number;
}

export interface SeverityWeights {
  faceDrop: number;
  bodyDrop: number;
  faceInstability: number;
  bodyInstability: number;
  duration: number;
}

export interface SeverityResult {
  /** 0~1 연속값 */
  severity: number;
  /** 운영자·감사용 등급 */
  label: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** 어떤 신호가 기여했는가 */
  reasons: DriftReason[];
  /** 신호별 기여도 — 근거 제시용 */
  contributions: Record<string, number>;
}

/** 임계값 미달분을 0~1로 정규화. 임계값 이상이면 0. */
function shortfall(value: number, threshold: number): number {
  if (!Number.isFinite(value) || threshold <= 0) return 0;
  if (value >= threshold) return 0;
  return Math.max(0, Math.min(1, (threshold - value) / threshold));
}

/** 임계값 초과분을 0~1로 정규화. 임계값 이하면 0. */
function excess(value: number | null, threshold: number): number {
  if (value === null || !Number.isFinite(value) || threshold <= 0) return 0;
  if (value <= threshold) return 0;
  return Math.max(0, Math.min(1, (value - threshold) / threshold));
}

export function computeSeverity(
  s: DriftSignals,
  th: SeverityThresholds,
  w: SeverityWeights,
): SeverityResult {
  const reasons: DriftReason[] = [];

  const faceDrop = shortfall(s.faceSimilarity, th.faceSimilarityThreshold);
  if (faceDrop > 0) reasons.push('face_similarity_drop');

  const bodyDrop = s.bodySimilarity === null
    ? 0
    : shortfall(s.bodySimilarity, th.bodySimilarityThreshold);
  if (bodyDrop > 0) reasons.push('body_similarity_drop');

  const faceInstab = excess(s.faceDelta, th.faceTemporalDeltaThreshold);
  if (faceInstab > 0) reasons.push('face_temporal_instability');

  const bodyInstab = excess(s.bodyDelta, th.bodyTemporalDeltaThreshold);
  if (bodyInstab > 0) reasons.push('body_temporal_instability');

  const durationFactor = th.durationSaturationSec > 0
    ? Math.max(0, Math.min(1, s.durationSec / th.durationSaturationSec))
    : 0;
  if (durationFactor >= 1) reasons.push('sustained_duration');

  // 신체 신호가 없으면 그 가중치를 얼굴 쪽으로 재분배한다.
  // 신체를 0으로 두면 신체 미검출이 곧 "정상"으로 읽혀 severity가 과소평가된다.
  const hasBody = s.bodySimilarity !== null || s.bodyDelta !== null;
  const wFaceDrop = hasBody ? w.faceDrop : w.faceDrop + w.bodyDrop;
  const wFaceInst = hasBody ? w.faceInstability : w.faceInstability + w.bodyInstability;
  const wBodyDrop = hasBody ? w.bodyDrop : 0;
  const wBodyInst = hasBody ? w.bodyInstability : 0;

  const contributions = {
    faceDrop: round(wFaceDrop * faceDrop),
    bodyDrop: round(wBodyDrop * bodyDrop),
    faceInstability: round(wFaceInst * faceInstab),
    bodyInstability: round(wBodyInst * bodyInstab),
    duration: round(w.duration * durationFactor),
  };

  const totalWeight = wFaceDrop + wBodyDrop + wFaceInst + wBodyInst + w.duration;
  const raw = Object.values(contributions).reduce((a, b) => a + b, 0);
  const severity = totalWeight > 0 ? round(Math.max(0, Math.min(1, raw / totalWeight))) : 0;

  return { severity, label: labelFor(severity), reasons, contributions };
}

export function labelFor(severity: number): SeverityResult['label'] {
  if (severity >= 0.75) return 'CRITICAL';
  if (severity >= 0.5) return 'HIGH';
  if (severity >= 0.25) return 'MEDIUM';
  return 'LOW';
}

function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
