import { describe, expect, it } from 'vitest';
import { checkSequenceConsistency } from '../sequence';

/**
 * 30초~4분짜리는 5초 컷 수십 개를 이어 붙여 만든다.
 * 컷마다 QC를 통과해도 1번 컷과 12번 컷의 인물이 서로 다를 수 있다 —
 * 이어 붙이기 전에 그것을 잡는 검사다.
 */
const seg = (segmentIndex: number, scores: Record<string, number>) => ({ segmentIndex, perIdentity: scores });

describe('시퀀스 인물 일관성', () => {
  it('구간마다 점수가 고르면 통과한다', () => {
    const v = checkSequenceConsistency(
      [seg(0, { a: 0.71 }), seg(1, { a: 0.75 }), seg(2, { a: 0.69 })], 0.15,
    );
    expect(v.ok).toBe(true);
    expect(v.perIdentity[0].spread).toBeCloseTo(0.06, 3);
  });

  it('컷마다 합격했어도 컷 사이 편차가 크면 막는다', () => {
    // 0.92와 0.63은 각각은 통과할 수 있지만 이어 붙이면 사람이 바뀐 것처럼 보인다
    const v = checkSequenceConsistency(
      [seg(0, { a: 0.92 }), seg(1, { a: 0.88 }), seg(2, { a: 0.63 })], 0.15,
    );
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toContain('2번');
  });

  it('가장 낮은 구간을 짚어 준다 — 어디를 고칠지 알아야 한다', () => {
    const v = checkSequenceConsistency(
      [seg(0, { a: 0.9 }), seg(7, { a: 0.5 }), seg(3, { a: 0.85 })], 0.15,
    );
    expect(v.perIdentity[0].worstSegmentIndex).toBe(7);
    expect(v.perIdentity[0].min).toBe(0.5);
    expect(v.perIdentity[0].max).toBe(0.9);
  });

  it('인물마다 따로 본다 — 한 명만 흔들려도 막는다', () => {
    const v = checkSequenceConsistency(
      [seg(0, { a: 0.8, b: 0.9 }), seg(1, { a: 0.78, b: 0.55 })], 0.15,
    );
    expect(v.ok).toBe(false);
    expect(v.reasons).toHaveLength(1);
    expect(v.perIdentity[0].identityId).toBe('b');
  });

  it('구간이 하나뿐이면 비교할 대상이 없어 통과한다', () => {
    expect(checkSequenceConsistency([seg(0, { a: 0.4 })], 0.15).ok).toBe(true);
  });

  it('점수가 없는 구간은 계산에서 빠진다', () => {
    const v = checkSequenceConsistency(
      [seg(0, { a: 0.8 }), seg(1, { a: Number.NaN }), seg(2, { a: 0.82 })], 0.15,
    );
    expect(v.ok).toBe(true);
    expect(v.perIdentity[0].spread).toBeCloseTo(0.02, 3);
  });

  it('편차가 큰 인물이 앞에 온다', () => {
    const v = checkSequenceConsistency(
      [seg(0, { a: 0.8, b: 0.9 }), seg(1, { a: 0.7, b: 0.88 })], 0.15,
    );
    expect(v.perIdentity[0].identityId).toBe('a');
  });
});
