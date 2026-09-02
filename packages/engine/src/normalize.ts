/**
 * 유사도 → 0~100 점수 변환 — CREZ 자체 구현.
 *
 * 코사인 유사도를 그대로 100배 하지 않는다. 얼굴 임베딩의 동일인 분포는
 * 보통 0.3~1.0 구간에 몰려 있어서, 0.5를 "50점"이라고 부르면 실제 의미와 어긋난다.
 *
 * 초기 baseline은 구간 선형 매핑이며, 검증셋이 쌓이면 calibration curve로
 * 교체할 수 있도록 변환기를 인터페이스로 분리한다. 매핑 파라미터는
 * 코드가 아니라 ruleset(DB)에서 온다.
 */

export interface NormalizationSpec {
  /** 이 값 이하는 0점 */
  floor: number;
  /** 이 값 이상은 100점 */
  ceiling: number;
  /** 'linear' | 'calibrated' — 향후 곡선 교체용 */
  curve?: 'linear' | 'calibrated';
  /** calibrated일 때 사용할 (similarity, score) 대응점 */
  controlPoints?: Array<[number, number]>;
}

export type Normalizer = (similarity: number) => number;

/** 구간 선형 매핑 (baseline) */
export function linearNormalizer(spec: NormalizationSpec): Normalizer {
  const { floor, ceiling } = spec;
  const span = ceiling - floor;
  return (s: number) => {
    if (!Number.isFinite(s)) return 0;
    if (span <= 0) return s >= ceiling ? 100 : 0;
    return round(Math.max(0, Math.min(100, ((s - floor) / span) * 100)));
  };
}

/**
 * 제어점 기반 보정 곡선.
 * 검증셋에서 얻은 (유사도, 사람이 매긴 점수) 쌍을 그대로 꽂아 쓸 수 있다.
 */
export function calibratedNormalizer(spec: NormalizationSpec): Normalizer {
  const pts = [...(spec.controlPoints ?? [])].sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return linearNormalizer(spec);

  return (s: number) => {
    if (!Number.isFinite(s)) return 0;
    if (s <= pts[0][0]) return round(pts[0][1]);
    if (s >= pts[pts.length - 1][0]) return round(pts[pts.length - 1][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      if (s >= x0 && s <= x1) {
        const t = x1 === x0 ? 0 : (s - x0) / (x1 - x0);
        return round(y0 + (y1 - y0) * t);
      }
    }
    return round(pts[pts.length - 1][1]);
  };
}

export function makeNormalizer(spec: NormalizationSpec): Normalizer {
  return spec.curve === 'calibrated' ? calibratedNormalizer(spec) : linearNormalizer(spec);
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
