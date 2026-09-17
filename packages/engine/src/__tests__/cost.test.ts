import { describe, expect, it } from 'vitest';
import { estimateRun } from '../cost';

/**
 * 4분 영상은 5초 구간 48개다. 실행 버튼 한 번이 48건의 유료 생성을 제출하므로,
 * 누르기 전에 얼마가 나가는지 알아야 한다. 제출한 요청은 취소가 거부될 수 있어 되돌릴 수 없다(§12.1).
 */
const segs = (n: number, durationMs = 5000) =>
  Array.from({ length: n }, (_, i) => ({ segmentId: `s${i}`, segmentIndex: i, durationMs }));
const rate = (costPerSecond: number, durations?: number[]) => ({ code: `m${costPerSecond}`, costPerSecond, durations });

describe('실행 전 비용 견적', () => {
  it('모델이 고정돼 있으면 최소와 최대가 같다', () => {
    // kling 2.5 turbo pro: 초당 0.25 → 5초 1건 1.25
    const e = estimateRun(segs(12), [rate(0.25)], 3);
    expect(e.min).toBe(15);
    expect(e.max).toBe(15);
    expect(e.segmentCount).toBe(12);
  });

  it('모델이 정해지지 않았으면 후보 단가의 구간으로 답한다', () => {
    const e = estimateRun(segs(4), [rate(0.25), rate(0.4), rate(0.3)], 3);
    expect(e.min).toBe(5);    // 4건 × 5초 × 0.25
    expect(e.max).toBe(8);    // 4건 × 5초 × 0.40
  });

  it('최악의 경우는 시도 한도를 다 쓴 값이다 — 추정이 아니라 상한', () => {
    const e = estimateRun(segs(2), [rate(0.25)], 3);
    expect(e.max).toBe(2.5);
    expect(e.worstCase).toBe(7.5);
  });

  it('4분짜리(48구간)도 구간별 내역을 낸다', () => {
    const e = estimateRun(segs(48), [rate(0.25)], 3);
    expect(e.perSegment).toHaveLength(48);
    expect(e.durationMs).toBe(240_000);
    expect(e.max).toBe(60);
  });

  it('구간 길이가 다르면 길이에 비례한다', () => {
    const e = estimateRun(
      [{ segmentId: 'a', segmentIndex: 0, durationMs: 10_000 },
       { segmentId: 'b', segmentIndex: 1, durationMs: 5_000 }],
      [rate(0.25)], 3,
    );
    expect(e.perSegment[0].max).toBe(2.5);
    expect(e.perSegment[1].max).toBe(1.25);
  });

  it('유료 단가가 없으면 무료로 표시한다 — mock·자체 호스팅만 쓰는 경우', () => {
    const e = estimateRun(segs(5), [rate(0), rate(Number.NaN)], 3);
    expect(e.free).toBe(true);
    expect(e.max).toBe(0);
  });

  it('구간이 없으면 0이다', () => {
    const e = estimateRun([], [rate(0.25)], 3);
    expect(e.max).toBe(0);
    expect(e.segmentCount).toBe(0);
  });
});

describe('제공자 길이 스냅', () => {
  it('제공자가 고정 길이만 받으면 그 길이로 과금된다', () => {
    // kling은 5초·10초만 받는다. 4초 구간은 5초로 올라가므로 견적도 5초로 잡아야 한다 —
    // 구간 길이로 계산하면 10건에 10이 나오지만 실제로는 12.5가 나간다(2026-09-17 지적).
    const four = Array.from({ length: 10 }, (_, i) => ({ segmentId: `s${i}`, segmentIndex: i, durationMs: 4000 }));
    expect(estimateRun(four, [rate(0.25, [5, 10])], 3).max).toBe(12.5);
    expect(estimateRun(four, [rate(0.25)], 3).max).toBe(10);   // 길이 제약이 없는 모델은 그대로
  });

  it('요청보다 짧게 스냅되는 경우도 그 길이로 계산한다', () => {
    const eleven = [{ segmentId: 's0', segmentIndex: 0, durationMs: 11_000 }];
    // 11초는 10초로 내려간다 — 과금도 10초다
    expect(estimateRun(eleven, [rate(0.25, [5, 10])], 3).max).toBe(2.5);
  });

  it('후보마다 스냅 길이가 다르면 비용 구간도 그만큼 벌어진다', () => {
    const four = [{ segmentId: 's0', segmentIndex: 0, durationMs: 4000 }];
    const e = estimateRun(four, [rate(0.25, [5, 10]), rate(0.25, [4, 6, 8])], 3);
    expect(e.min).toBe(1);      // 4초 × 0.25
    expect(e.max).toBe(1.25);   // 5초 × 0.25
  });
});
