import { describe, expect, it } from 'vitest';

/**
 * 얼굴 centroid에 무엇을 넣을 것인가 (§6.1, §10.1).
 *
 * 2026-09-21 실측(CRZ-A008, 같은 영상·같은 모델, centroid만 교체):
 *   클로즈업 얼굴 4장            → 얼굴 유사도 0.707
 *   전신 사진의 얼굴까지 포함 9장 → 0.807
 *   90° 측면까지 전부 11장        → 0.790
 *
 * 그리고 90° 측면 사진은 본인의 다른 사진들과 0.169·0.182로, 타인 분포(평균 0.143)와 구분되지 않는다.
 * 그래서 "전신 사진의 얼굴은 넣고, 90° 측면은 뺀다"가 결론이다.
 */

/** 프로파일 빌드가 쓰는 선별 규칙 — ingest.ts와 같은 조건을 따로 검증한다 */
function centroidInputs(
  embeddings: Array<{ assetId: string }>,
  slotOf: Record<string, string | null>,
): Array<{ assetId: string }> {
  return embeddings.filter((e) => {
    const slot = slotOf[e.assetId];
    return slot !== 'LEFT_90' && slot !== 'RIGHT_90';
  });
}

describe('얼굴 centroid 입력 선별', () => {
  const slots: Record<string, string | null> = {
    f1: 'FRONT', f2: 'FRONT', f3: 'LEFT_45', f4: 'RIGHT_45',
    f5: 'LEFT_90', f6: 'RIGHT_90',
    b1: 'BODY_FRONT', b2: 'BODY_FRONT',
  };
  const all = Object.keys(slots).map((assetId) => ({ assetId }));

  it('90° 측면은 뺀다 — 정면 학습 모델이 타인처럼 본다', () => {
    const kept = centroidInputs(all, slots).map((e) => e.assetId);
    expect(kept).not.toContain('f5');
    expect(kept).not.toContain('f6');
  });

  it('전신 사진에서 뽑은 얼굴은 넣는다 — 영상은 인물이 멀리 잡힌다', () => {
    const kept = centroidInputs(all, slots).map((e) => e.assetId);
    expect(kept).toContain('b1');
    expect(kept).toContain('b2');
  });

  it('정면·45°는 그대로 남는다', () => {
    const kept = centroidInputs(all, slots).map((e) => e.assetId);
    expect(kept).toEqual(['f1', 'f2', 'f3', 'f4', 'b1', 'b2']);
  });

  it('슬롯을 모르는 임베딩은 제외하지 않는다 — 판단 근거가 없으면 빼지 않는다', () => {
    const kept = centroidInputs([{ assetId: 'x' }], {});
    expect(kept).toHaveLength(1);
  });
});
