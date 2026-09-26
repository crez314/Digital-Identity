import { describe, expect, it } from 'vitest';
import { inspectPrompt, summarizeRisks } from '../prompt-guard';

/**
 * 2026-09-16 실측 사례를 고정한다.
 * 사무실 전신 사진 + "케데헌 무대에서 멤버들과 같이 춤추는 / 헤어스타일은 최신 유행" 프롬프트로
 * kling v2.5 turbo pro를 돌렸더니 1.25초에 장면이 바뀌고 3.75초에 인물이 교체됐다(QC 0.373).
 * 실행 전에 이 프롬프트에서 위험을 잡아내지 못하면 같은 실패를 또 돈 주고 산다.
 */
const REAL_CASE = 'kpop 댄스 추는 영상 만들어줘 헤어 스타일은 최신 유행하는 헤어스타일에\n'
  + '케데헌 무대에서 맴버들과 같이 춤는 영상';

describe('프롬프트 위험 검사', () => {
  it('실패한 실제 프롬프트에서 세 가지 위험을 모두 잡는다', () => {
    const risks = inspectPrompt(REAL_CASE, { mode: 'i2v', castCount: 1 });
    const kinds = risks.map((r) => r.kind).sort();
    expect(kinds).toEqual(['APPEARANCE_CHANGE', 'MULTI_PERSON', 'SCENE_CHANGE']);
    expect(summarizeRisks(risks)).toContain('맴버들');
  });

  it('인물을 여럿 캐스팅했으면 다중 인물은 위험이 아니다', () => {
    const risks = inspectPrompt('멤버들과 같이 춤추는 영상', { mode: 'i2v', castCount: 3 });
    expect(risks.map((r) => r.kind)).not.toContain('MULTI_PERSON');
  });

  it('시작 이미지가 없는 모드에서는 장소 변경을 문제 삼지 않는다', () => {
    const risks = inspectPrompt('무대에서 노래하는 영상', { mode: 't2v', castCount: 1 });
    expect(risks.map((r) => r.kind)).not.toContain('SCENE_CHANGE');
  });

  it('깨끗한 프롬프트에는 경고가 없다', () => {
    const risks = inspectPrompt('제자리에서 가볍게 리듬을 타는 모습', { mode: 'i2v', castCount: 1 });
    expect(risks).toEqual([]);
  });

  it('프롬프트가 비어 있으면 검사할 것이 없다', () => {
    expect(inspectPrompt(null, { mode: 'i2v', castCount: 1 })).toEqual([]);
    expect(inspectPrompt('   ', { mode: 'i2v', castCount: 1 })).toEqual([]);
  });

  it('걸린 표현을 그대로 돌려준다 — 어느 단어를 고쳐야 하는지 알아야 한다', () => {
    const risks = inspectPrompt('배경을 바꿔줘', { mode: 'i2v', castCount: 1 });
    expect(risks[0].term).toBe('배경을 바꿔');
  });
});
