/**
 * 시퀀스(컷 묶음) 단위 인물 일관성 검사 (§10.3 확장).
 *
 * 구간별 QC는 "이 컷 안에서 인물이 유지되는가"만 본다. 그런데 30초~4분짜리는 5초 컷을
 * 수십 개 이어 붙여 만들기 때문에, 컷마다 각각 합격해도 1번 컷과 12번 컷의 인물이
 * 서로 다르게 보일 수 있다. 이어 붙이기 전에 컷 사이의 편차를 한 번 더 본다.
 *
 * ruleset의 maxSpread는 "한 컷 안 캐스트 인물 간" 편차용이라 여기 쓰지 않는다.
 * 이 검사는 sequenceMaxSpread를 쓴다.
 */

export interface SequenceSegmentScore {
  segmentIndex: number;
  /** identityId → 그 구간에서의 인물 점수 */
  perIdentity: Record<string, number>;
}

export interface IdentitySpread {
  identityId: string;
  min: number;
  max: number;
  spread: number;
  /** 가장 낮은 점수가 나온 구간 — 손볼 곳을 바로 짚어 준다 */
  worstSegmentIndex: number;
  /** 편차가 한도를 넘었는가 */
  exceeded: boolean;
}

export interface SequenceVerdict {
  ok: boolean;
  /** 검사에 쓴 구간 수 */
  segmentCount: number;
  perIdentity: IdentitySpread[];
  /** 사람이 읽을 사유 — 실패했을 때만 채운다 */
  reasons: string[];
}

/**
 * 구간별 인물 점수에서 인물마다 최저·최고·편차를 구하고 한도와 비교한다.
 *
 * 구간이 1개뿐이면 비교 대상이 없으므로 항상 통과다 — 편차 0을 "일관적"이라고
 * 말하는 것은 맞지만, 그건 이 검사가 할 일이 없다는 뜻이기도 하다.
 */
export function checkSequenceConsistency(
  segments: SequenceSegmentScore[],
  sequenceMaxSpread: number,
): SequenceVerdict {
  const byIdentity = new Map<string, Array<{ segmentIndex: number; score: number }>>();
  for (const s of segments) {
    for (const [identityId, score] of Object.entries(s.perIdentity)) {
      if (!Number.isFinite(score)) continue;
      const list = byIdentity.get(identityId) ?? [];
      list.push({ segmentIndex: s.segmentIndex, score });
      byIdentity.set(identityId, list);
    }
  }

  const perIdentity: IdentitySpread[] = [];
  const reasons: string[] = [];

  for (const [identityId, list] of byIdentity) {
    const worst = list.reduce((a, b) => (b.score < a.score ? b : a));
    const min = worst.score;
    const max = list.reduce((a, b) => (b.score > a.score ? b : a)).score;
    const spread = Number((max - min).toFixed(4));
    const exceeded = list.length > 1 && spread > sequenceMaxSpread;
    perIdentity.push({
      identityId, min, max, spread, worstSegmentIndex: worst.segmentIndex, exceeded,
    });
    if (exceeded) {
      reasons.push(
        `인물 ${identityId}: 구간 간 점수 편차 ${spread.toFixed(3)} (허용 ${sequenceMaxSpread}) — `
        + `가장 낮은 구간은 ${worst.segmentIndex}번(${min.toFixed(3)}), 가장 높은 구간은 ${max.toFixed(3)}`,
      );
    }
  }

  perIdentity.sort((a, b) => b.spread - a.spread);
  return { ok: reasons.length === 0, segmentCount: segments.length, perIdentity, reasons };
}
