import { describe, expect, it } from 'vitest';
import { compositeScore, judgeMultiPerson } from '../scoring';
import { TH } from './fixtures';

const W = { face: 0.45, body: 0.2, temporal: 0.2, binding: 0.1, motion: 0.05 };

describe('점수 체계 (§10)', () => {
  it('가중합으로 종합 점수를 산출한다', () => {
    const s = compositeScore(
      { faceSimilarity: 1, bodySimilarity: 1, temporalConsistency: 1, motionConsistency: 1, bindingStability: 1 },
      W,
    );
    expect(s).toBe(1);
  });

  it('motion이 없으면(소스 안무 미제공) 가중치를 재분배한다', () => {
    const s = compositeScore(
      { faceSimilarity: 0.8, bodySimilarity: 0.8, temporalConsistency: 0.8, motionConsistency: null, bindingStability: 0.8 },
      W,
    );
    expect(s).toBeCloseTo(0.8, 5);
  });

  it('§10.3 한 명만 낮으면 프로젝트는 불합격이고 그 인물이 지목된다', () => {
    const v = judgeMultiPerson({ a: 0.93, b: 0.92, c: 0.6 }, TH);
    expect(v.passed).toBe(false);
    expect(v.failingIdentityIds).toEqual(['c']);
    expect(v.reasons.join(' ')).toContain('perIdentityMin');
  });

  it('§10.3 편차가 크면 전원이 하한을 넘어도 불합격', () => {
    const v = judgeMultiPerson({ a: 0.99, b: 0.86 }, TH);
    expect(v.passed).toBe(false);
    expect(v.reasons.join(' ')).toContain('편차');
  });

  it('종합 점수는 캐스트 최솟값 기준이다 (§20 Multi-Person KPI)', () => {
    const v = judgeMultiPerson({ a: 0.99, b: 0.93, c: 0.95 }, TH);
    expect(v.overallScore).toBe(0.93);
    expect(v.passed).toBe(true);
  });
});
