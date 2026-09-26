import { describe, expect, it } from 'vitest';
import { leadIndexFor } from '../processors/generation';

/**
 * image-to-video는 대표 이미지가 곧 시작 프레임이다.
 * 구간마다 돌리지 않으면 1분 영상의 컷 12개가 전부 같은 장소·같은 포즈에서 출발한다(§5.1).
 */
describe('구간별 대표 레퍼런스', () => {
  it('구간 번호를 따라 대표가 돌아간다', () => {
    expect([0, 1, 2, 3, 4].map((i) => leadIndexFor(3, i))).toEqual([0, 1, 2, 0, 1]);
  });

  it('같은 구간은 항상 같은 사진을 쓴다 — 재실행 결과를 비교할 수 있어야 한다', () => {
    expect(leadIndexFor(4, 7)).toBe(leadIndexFor(4, 7));
  });

  it('사진이 1장뿐이면 돌릴 것이 없다', () => {
    expect(leadIndexFor(1, 5)).toBe(0);
  });

  it('사진이 없으면 대표도 없다', () => {
    expect(leadIndexFor(0, 3)).toBe(-1);
  });

  it('음수 구간 번호에도 유효한 자리를 돌려준다', () => {
    expect(leadIndexFor(3, -1)).toBe(2);
  });
});
