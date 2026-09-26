import { describe, expect, it } from 'vitest';
import { judgeEvidence } from '../evidence';

/**
 * 2026-09-18 실측 — 같은 인물, 같은 레퍼런스, 해상도만 다름:
 *   84px → 0.504 · 87px → 0.443 · 113px → 0.556 · 140px → 0.711
 * 얼굴 픽셀 크기가 점수를 좌우한다. 낮은 점수를 "닮지 않았다"로 읽으면 안 되는 구간이 있다.
 */
describe('판정 근거의 두께', () => {
  it('얼굴이 충분히 크면 점수를 그대로 믿는다', () => {
    const v = judgeEvidence(140, 110);
    expect(v.level).toBe('OK');
    expect(v.note).toBeNull();
  });

  it('기준보다 작으면 점수를 그대로 믿지 말라고 알린다', () => {
    const v = judgeEvidence(87, 110);
    expect(v.level).toBe('WEAK');
    expect(v.note).toContain('87px');
    expect(v.note).toContain('해상도');
  });

  it('경계값은 통과시킨다', () => {
    expect(judgeEvidence(110, 110).level).toBe('OK');
  });

  it('얼굴을 못 잡았으면 근거 자체가 없다', () => {
    expect(judgeEvidence(null, 110).level).toBe('UNKNOWN');
    expect(judgeEvidence(undefined, 110).level).toBe('UNKNOWN');
    expect(judgeEvidence(Number.NaN, 110).level).toBe('UNKNOWN');
  });

  it('기준은 호출부가 정한다 — ruleset에서 온다', () => {
    expect(judgeEvidence(113, 150).level).toBe('WEAK');
    expect(judgeEvidence(113, 100).level).toBe('OK');
  });
});
