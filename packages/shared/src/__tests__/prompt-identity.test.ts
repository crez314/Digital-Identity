import { describe, expect, it } from 'vitest';
import {
  IDENTITY_ANCHOR, IDENTITY_NEGATIVE_PROMPT, promptAdherenceFromConditioning, withIdentityAnchor,
} from '../prompt-identity';

describe('신원 고정 프롬프트', () => {
  it('운영자 문장은 그대로 두고 뒤에 붙인다', () => {
    const out = withIdentityAnchor('무대에서 춤추는 영상');
    expect(out.startsWith('무대에서 춤추는 영상')).toBe(true);
    expect(out).toContain(IDENTITY_ANCHOR);
  });

  it('두 번 붙이지 않는다 — 재생성에서 프롬프트를 복원해 다시 보내도 같아야 한다', () => {
    const once = withIdentityAnchor('춤추는 영상');
    expect(withIdentityAnchor(once)).toBe(once);
  });

  it('프롬프트가 비어도 신원 제약은 보낸다', () => {
    expect(withIdentityAnchor(null)).toBe(IDENTITY_ANCHOR);
    expect(withIdentityAnchor('  ')).toBe(IDENTITY_ANCHOR);
  });

  it('의상은 레퍼런스가 아니라 클립 내내 일관되게만 건다', () => {
    // same outfit이면 레퍼런스 사진의 옷이 운영자가 지정한 무대 의상을 이긴다
    expect(IDENTITY_ANCHOR).not.toContain('same outfit');
    expect(IDENTITY_ANCHOR).toContain('stays the same from the first frame to the last');
  });

  it('부정 프롬프트가 인물 교체와 컷 전환을 막는다', () => {
    expect(IDENTITY_NEGATIVE_PROMPT).toContain('different person');
    expect(IDENTITY_NEGATIVE_PROMPT).toContain('scene change');
  });
});

describe('cfg_scale 변환', () => {
  it('신원 조건화가 셀수록 프롬프트 준수는 약해진다', () => {
    expect(promptAdherenceFromConditioning(0.6)).toBe(0.4);
    expect(promptAdherenceFromConditioning(0.75)).toBe(0.25);
    expect(promptAdherenceFromConditioning(0)).toBe(1);
    expect(promptAdherenceFromConditioning(1)).toBe(0);
  });

  it('범위를 벗어난 값과 NaN을 방어한다', () => {
    expect(promptAdherenceFromConditioning(1.7)).toBe(0);
    expect(promptAdherenceFromConditioning(-3)).toBe(1);
    expect(promptAdherenceFromConditioning(Number.NaN)).toBe(0.4);
  });
});
