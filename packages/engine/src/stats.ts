/**
 * 시계열 통계 — CREZ 자체 구현.
 *
 * 평균만으로는 신원 붕괴를 놓친다. 30초 영상에서 2초만 무너져도 평균은 거의
 * 움직이지 않지만 시청자는 그 2초를 본다. 따라서 하위 백분위와 최솟값을
 * 함께 산출해 "가장 나쁜 구간"이 점수에 반영되도록 한다.
 */

export interface SeriesStats {
  mean: number;
  median: number;
  min: number;
  max: number;
  p05: number;
  p10: number;
  stdDev: number;
  count: number;
}

/** 선형 보간 백분위 (0..1) */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * Math.max(0, Math.min(1, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function seriesStats(values: number[]): SeriesStats {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) {
    return { mean: 0, median: 0, min: 0, max: 0, p05: 0, p10: 0, stdDev: 0, count: 0 };
  }
  const sorted = [...clean].sort((a, b) => a - b);
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((s, v) => s + (v - mean) ** 2, 0) / clean.length;
  return {
    mean: round(mean),
    median: round(percentile(sorted, 0.5)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    p05: round(percentile(sorted, 0.05)),
    p10: round(percentile(sorted, 0.1)),
    stdDev: round(Math.sqrt(variance)),
    count: clean.length,
  };
}

/**
 * 임베딩 분산 — 시계열 벡터가 얼마나 흩어져 있는가.
 * 값이 크면 같은 인물이라도 프레임마다 다르게 표현되고 있다는 뜻이다.
 */
export function embeddingVariance(deltas: Array<number | null>): number {
  const clean = deltas.filter((d): d is number => d !== null && Number.isFinite(d));
  if (clean.length === 0) return 0;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  return round(clean.reduce((s, d) => s + (d - mean) ** 2, 0) / clean.length, 6);
}

function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
