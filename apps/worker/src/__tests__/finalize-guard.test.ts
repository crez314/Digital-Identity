import { describe, expect, it } from 'vitest';
import { isLastAttempt, isUniqueViolation } from '../processors/generation';

/**
 * 결과물을 저장하기 전에 SUCCEEDED로 확정하면, 내려받기 도중 워커가 죽었을 때
 * "결과물 없는 성공"으로 남는다. 폴링은 종료 상태를 건너뛰고 reconciler는 SUBMITTED·RUNNING만
 * 훑기 때문에 아무도 복구하지 못하고, 이미 지불한 결과를 다시 가져올 길이 사라진다(2026-09-17 지적).
 *
 * 그래서 저장에 성공한 다음에 확정하고, 중복은 generation_output.job_id 유일 제약이 막는다.
 */
describe('결과물 수집 실패 처리', () => {
  it('큐 재시도가 남아 있으면 실패로 확정하지 않는다', () => {
    expect(isLastAttempt({ attemptsMade: 0, opts: { attempts: 3 } })).toBe(false);
    expect(isLastAttempt({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false);
  });

  it('마지막 시도에서만 확정한다', () => {
    expect(isLastAttempt({ attemptsMade: 2, opts: { attempts: 3 } })).toBe(true);
  });

  /**
   * BullMQ는 옵션을 주지 않으면 attempts를 **0**으로 박는다. 예전 구현은 `opts.attempts ?? 1`이라
   * 그 0을 거르지 못해 모든 폴링 작업이 "항상 마지막 시도"가 됐고, 스토리지가 한 번 깜빡이면
   * 이미 과금된 결과를 그대로 버렸다. 설정이 없으면 큐 정책(generation: 3회)을 따른다.
   */
  it('재시도 설정이 없으면 큐 정책을 따른다 — 첫 실패에 결과를 버리지 않는다', () => {
    expect(isLastAttempt({})).toBe(false);
    expect(isLastAttempt({ attemptsMade: 0, opts: {} })).toBe(false);
    expect(isLastAttempt({ attemptsMade: 0, opts: { attempts: 0 } })).toBe(false);
    expect(isLastAttempt({ attemptsMade: 2, opts: {} })).toBe(true);
  });
});

describe('중복 저장 경쟁', () => {
  it('유일 제약 위반은 실패가 아니라 "남이 먼저 저장했다"는 뜻이다', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it('다른 오류는 그대로 오류다', () => {
    expect(isUniqueViolation({ code: 'P2025' })).toBe(false);
    expect(isUniqueViolation(new Error('network down'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
