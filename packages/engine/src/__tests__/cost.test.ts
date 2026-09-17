import { describe, expect, it } from 'vitest';
import { estimateRun } from '../cost';

/**
 * 4분 영상은 5초 구간 48개다. 실행 버튼 한 번이 48건의 유료 생성을 제출하므로,
 * 누르기 전에 얼마가 나가는지 알아야 한다. 제출한 요청은 취소가 거부될 수 있어 되돌릴 수 없다(§12.1).
 */
const segs = (n: number, durationMs = 5000) =>
  Array.from({ length: n }, (_, i) => ({ segmentId: `s${i}`, segmentIndex: i, durationMs }));

describe('실행 전 비용 견적', () => {
  it('모델이 고정돼 있으면 최소와 최대가 같다', () => {
    // kling 2.5 turbo pro: 초당 0.25 → 5초 1건 1.25
    const e = estimateRun(segs(12), [0.25], 3);
    expect(e.min).toBe(15);
    expect(e.max).toBe(15);
    expect(e.segmentCount).toBe(12);
  });

  it('모델이 정해지지 않았으면 후보 단가의 구간으로 답한다', () => {
    const e = estimateRun(segs(4), [0.25, 0.4, 0.3], 3);
    expect(e.min).toBe(5);    // 4건 × 5초 × 0.25
    expect(e.max).toBe(8);    // 4건 × 5초 × 0.40
  });

  it('최악의 경우는 시도 한도를 다 쓴 값이다 — 추정이 아니라 상한', () => {
    const e = estimateRun(segs(2), [0.25], 3);
    expect(e.max).toBe(2.5);
    expect(e.worstCase).toBe(7.5);
  });

  it('4분짜리(48구간)도 구간별 내역을 낸다', () => {
    const e = estimateRun(segs(48), [0.25], 3);
    expect(e.perSegment).toHaveLength(48);
    expect(e.durationMs).toBe(240_000);
    expect(e.max).toBe(60);
  });

  it('구간 길이가 다르면 길이에 비례한다', () => {
    const e = estimateRun(
      [{ segmentId: 'a', segmentIndex: 0, durationMs: 10_000 },
       { segmentId: 'b', segmentIndex: 1, durationMs: 5_000 }],
      [0.25], 3,
    );
    expect(e.perSegment[0].max).toBe(2.5);
    expect(e.perSegment[1].max).toBe(1.25);
  });

  it('유료 단가가 없으면 무료로 표시한다 — mock·자체 호스팅만 쓰는 경우', () => {
    const e = estimateRun(segs(5), [0, Number.NaN], 3);
    expect(e.free).toBe(true);
    expect(e.max).toBe(0);
  });

  it('구간이 없으면 0이다', () => {
    const e = estimateRun([], [0.25], 3);
    expect(e.max).toBe(0);
    expect(e.segmentCount).toBe(0);
  });
});
