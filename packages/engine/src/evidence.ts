/**
 * 판정 근거의 두께 (§10.1).
 *
 * 얼굴 유사도는 얼굴이 화면에서 몇 픽셀인지에 크게 좌우된다. 얼굴이 작으면 임베딩이 흐려져
 * 같은 사람도 낮게 나온다 — 2026-09-18 실측에서 같은 인물·같은 레퍼런스로
 * 84px 0.504 / 87px 0.443 / 113px 0.556 / 140px 0.711이 나왔다.
 *
 * 그래서 낮은 점수를 볼 때 "닮지 않았다"와 "너무 작아 판정할 수 없다"를 구분해야 한다.
 * 구분하지 않으면 해상도가 낮은 제공자를 모델 실력이 나쁜 것으로 오해하고,
 * 재생성 사다리는 고칠 수 없는 것을 고치려고 돈을 쓴다.
 */

export type EvidenceLevel = 'OK' | 'WEAK' | 'UNKNOWN';

export interface EvidenceVerdict {
  level: EvidenceLevel;
  medianFaceHeightPx: number | null;
  minFaceHeightPx: number;
  /** 운영자에게 보여 줄 설명. 충분하면 null */
  note: string | null;
}

/**
 * @param medianFaceHeightPx crez-ml이 돌려준 얼굴 픽셀 높이 중앙값. 얼굴을 못 잡았으면 null
 */
export function judgeEvidence(
  medianFaceHeightPx: number | null | undefined,
  minFaceHeightPx: number,
): EvidenceVerdict {
  const px = typeof medianFaceHeightPx === 'number' && Number.isFinite(medianFaceHeightPx)
    ? medianFaceHeightPx : null;

  if (px === null) {
    return {
      level: 'UNKNOWN', medianFaceHeightPx: null, minFaceHeightPx,
      note: '얼굴을 잡지 못해 신원 점수의 근거가 없습니다',
    };
  }
  if (px < minFaceHeightPx) {
    return {
      level: 'WEAK', medianFaceHeightPx: px, minFaceHeightPx,
      note: `얼굴이 ${Math.round(px)}px로 작아(기준 ${minFaceHeightPx}px) 얼굴 유사도를 그대로 믿기 어렵습니다 — `
        + '해상도를 올리거나 인물이 더 크게 잡히는 구도로 다시 만드세요',
    };
  }
  return { level: 'OK', medianFaceHeightPx: px, minFaceHeightPx, note: null };
}
