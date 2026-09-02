/**
 * 거리·유사도 지표 — §6.
 *
 * 신체 비교는 코사인만으로 부족할 때가 있다. 코사인은 방향만 보므로
 * 크기(색 강도·대비) 차이를 놓치는 반면, 유클리드 거리는 그것까지 반영한다.
 * 최종 신체 점수는 코사인을 기준으로 하되, 두 값을 모두 기록해
 * 나중에 어느 쪽이 더 잘 맞는지 검증셋으로 비교할 수 있게 한다.
 */

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * L2 정규화된 벡터에서 두 지표는 대수적으로 대응한다.
 *   ‖a-b‖² = 2(1 - cos)   →   d = √(2(1-cos))
 * 인코더가 정규화를 보장하므로 벡터 없이 코사인만으로도 거리를 얻을 수 있다.
 */
export function euclideanFromCosine(cos: number): number {
  return Math.sqrt(Math.max(0, 2 * (1 - cos)));
}

export interface DistancePair {
  cosine: number;
  euclidean: number;
}

export function compare(a: number[], b: number[]): DistancePair {
  return { cosine: cosineSimilarity(a, b), euclidean: euclideanDistance(a, b) };
}
