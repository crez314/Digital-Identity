import { MAX_REGEN, PAID_AUTO_REGEN_LIMIT } from '@crez/shared';

/**
 * QC 실패 후 자동 재생성을 더 돌릴지 판단한다 (§5.1, §11).
 *
 * 유료 제공자는 자동 재생성이 곧 자동 과금이다. 게다가 한 번 제출하면 제공자가 취소를 거부할 수 있어
 * 되돌릴 수도 없다(§12.1 — Higgsfield는 in_progress 요청의 취소를 400으로 거절한다).
 * 그래서 과금 모델에는 별도 한도를 두고, 기본값은 0(자동 재생성 없음)이다.
 */

/** ai_model.capabilities.billable — 실제 과금되는 제공자인지 (시드가 표시한다) */
export function isBillable(capabilities: unknown): boolean {
  return (capabilities as { billable?: boolean } | null)?.billable === true;
}

export function paidAutoRegenLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PAID_AUTO_REGEN_LIMIT ?? PAID_AUTO_REGEN_LIMIT);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : PAID_AUTO_REGEN_LIMIT;
}

export type AutoRegenDecision =
  | { allowed: true }
  | { allowed: false; reason: 'REGEN_LIMIT' | 'PAID_PROVIDER_LIMIT'; limit: number };

export function autoRegenDecision(input: {
  billable: boolean;
  /** segment.attempt_count */
  attemptCount: number;
  /** 지금까지 만들어진 regeneration_task 수 */
  regenCount: number;
  paidLimit?: number;
}): AutoRegenDecision {
  if (input.attemptCount >= MAX_REGEN || input.regenCount >= MAX_REGEN) {
    return { allowed: false, reason: 'REGEN_LIMIT', limit: MAX_REGEN };
  }
  if (input.billable) {
    const limit = input.paidLimit ?? paidAutoRegenLimit();
    if (input.regenCount >= limit) return { allowed: false, reason: 'PAID_PROVIDER_LIMIT', limit };
  }
  return { allowed: true };
}
