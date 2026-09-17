import { describe, expect, it } from 'vitest';
import { autoRegenDecision, isBillable, paidAutoRegenLimit } from '../lib/regen-policy';

describe('자동 재생성 정책 (§11, §12.1)', () => {
  it('무료(mock) 제공자는 기존대로 한도까지 자동 재생성한다', () => {
    expect(autoRegenDecision({ billable: false, attemptCount: 1, regenCount: 0 })).toEqual({ allowed: true });
    expect(autoRegenDecision({ billable: false, attemptCount: 2, regenCount: 2 })).toEqual({ allowed: true });
    expect(autoRegenDecision({ billable: false, attemptCount: 3, regenCount: 2 }))
      .toEqual({ allowed: false, reason: 'REGEN_LIMIT', limit: 3 });
  });

  it('과금 제공자는 기본값에서 자동 재생성하지 않는다 — 운영자가 수동으로만 돌린다', () => {
    expect(autoRegenDecision({ billable: true, attemptCount: 1, regenCount: 0, paidLimit: 0 }))
      .toEqual({ allowed: false, reason: 'PAID_PROVIDER_LIMIT', limit: 0 });
  });

  it('한도를 올리면 그만큼만 자동 재생성한다', () => {
    expect(autoRegenDecision({ billable: true, attemptCount: 1, regenCount: 0, paidLimit: 1 })).toEqual({ allowed: true });
    expect(autoRegenDecision({ billable: true, attemptCount: 2, regenCount: 1, paidLimit: 1 }))
      .toEqual({ allowed: false, reason: 'PAID_PROVIDER_LIMIT', limit: 1 });
  });

  it('과금 한도를 아무리 올려도 전체 재생성 한도를 넘지 않는다', () => {
    expect(autoRegenDecision({ billable: true, attemptCount: 3, regenCount: 0, paidLimit: 99 }))
      .toEqual({ allowed: false, reason: 'REGEN_LIMIT', limit: 3 });
  });

  it('환경변수로 한도를 바꾸고, 값이 이상하면 기본값을 쓴다', () => {
    expect(paidAutoRegenLimit({} as NodeJS.ProcessEnv)).toBe(0);
    expect(paidAutoRegenLimit({ PAID_AUTO_REGEN_LIMIT: '2' } as never)).toBe(2);
    expect(paidAutoRegenLimit({ PAID_AUTO_REGEN_LIMIT: '-1' } as never)).toBe(0);
    expect(paidAutoRegenLimit({ PAID_AUTO_REGEN_LIMIT: 'x' } as never)).toBe(0);
  });

  it('과금 여부는 모델 capabilities.billable로만 판단한다', () => {
    expect(isBillable({ billable: true })).toBe(true);
    expect(isBillable({ billable: false })).toBe(false);
    expect(isBillable({})).toBe(false);
    expect(isBillable(null)).toBe(false);
  });
});
