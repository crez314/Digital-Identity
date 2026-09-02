import { describe, expect, it } from 'vitest';
import { allConfirmed, judgeAssignments } from '../binding';

describe('Identity Binding 판정 (§9.1)', () => {
  const a = (over = {}) => ({
    trackIndex: 0, identityId: 'x', similarity: 0.8,
    runnerUpIdentityId: 'y', runnerUpSimilarity: 0.5, margin: 0.3, ...over,
  });

  it('유사도·margin이 충분하면 확정한다', () => {
    const [v] = judgeAssignments([a()]);
    expect(v.needsReview).toBe(false);
    expect(v.confidence).toBeGreaterThan(0.5);
  });

  it('τ_assign 미만이면 운영자 확인 대상으로 올린다', () => {
    const [v] = judgeAssignments([a({ similarity: 0.2 })]);
    expect(v.needsReview).toBe(true);
    expect(v.reason).toContain('τ_assign');
  });

  it('1·2순위 차가 δ_margin 미만이면 확정하지 않는다', () => {
    const [v] = judgeAssignments([a({ similarity: 0.6, runnerUpSimilarity: 0.58, margin: 0.02 })]);
    expect(v.needsReview).toBe(true);
    expect(v.reason).toContain('δ_margin');
  });

  it('미확정 트랙이 남아 있으면 생성 게이트를 통과하지 못한다', () => {
    expect(allConfirmed(judgeAssignments([a(), a({ trackIndex: 1, similarity: 0.1 })]))).toBe(false);
    expect(allConfirmed(judgeAssignments([a()]))).toBe(true);
  });
});
