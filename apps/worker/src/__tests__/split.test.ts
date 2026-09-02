import { describe, expect, it } from 'vitest';
import { splitBounds } from '../processors/regeneration';

describe('세그먼트 재분할 (§11 3단계)', () => {
  it('상한 이하 세그먼트는 쪼개지 않는다', () => {
    expect(splitBounds(0, 3000, 4000)).toEqual([0, 3000]);
  });

  it('상한을 넘으면 균등 분할한다', () => {
    const b = splitBounds(0, 12000, 4000);
    expect(b[0]).toBe(0);
    expect(b[b.length - 1]).toBe(12000);
    expect(b.length - 1).toBe(3);
  });

  it('모든 조각이 상한을 넘지 않는다', () => {
    const b = splitBounds(1000, 11000, 3000);
    for (let i = 0; i < b.length - 1; i++) {
      expect(b[i + 1] - b[i]).toBeLessThanOrEqual(3000);
    }
  });

  it('경계는 단조 증가하며 원래 구간을 빠짐없이 덮는다', () => {
    const b = splitBounds(500, 9500, 2500);
    expect(b[0]).toBe(500);
    expect(b[b.length - 1]).toBe(9500);
    for (let i = 1; i < b.length; i++) expect(b[i]).toBeGreaterThan(b[i - 1]);
  });

  it('상한이 비정상적으로 작아도 1초 미만으로 쪼개지 않는다', () => {
    const b = splitBounds(0, 5000, 10);
    for (let i = 0; i < b.length - 1; i++) {
      expect(b[i + 1] - b[i]).toBeGreaterThanOrEqual(1000);
    }
  });
});
