import {
  generationDispatchId, lockOrganizationSpend, nextGenerationAttempt, prisma, reserveSpend,
} from '@crez/db';
import { CrezError, ErrorCode, MAX_GENERATION_ATTEMPT, QUEUE_POLICY, QUEUE, childLogger } from '@crez/shared';
import { JOB_NAME } from '@crez/contracts';
import { queues } from './queues';

/**
 * 콘텐츠 정책(nsfw) 거부의 규칙 기반 자동 재시도.
 *
 * 대상은 **결과물 판정**으로 온 거부뿐이다(poll에서 state=nsfw). 제출 단계 400은 요청 자체를 거절한 것이라
 * 다시 보내도 같은 답이 오므로 여기로 오지 않는다.
 *
 * 제공자는 결과물을 보고 nsfw를 판정한다 — 같은 프롬프트·같은 레퍼런스로 보낸 요청이
 * 성공하기도 하고 거부되기도 한다(실측: 접수 12건 중 9건 성공 / 3건 nsfw. 30초 구간이 5초보다 훨씬 자주 걸렸다).
 * 그래서 첫 거부는 "다시 뽑아 보면 되는 것"으로 보고 자동으로 한 번 더 제출한다.
 *
 * 다만 무한히 다시 보내지는 않는다. 같은 구간이 연달아 거부되면 그건 내용을 바꾸라는 신호다.
 * 재시도는 다음 규칙을 모두 지킨다:
 *  1. 구간당 정책 거부 재제출은 GEN_POLICY_RETRY_LIMIT(기본 1)회까지.
 *  2. §5.1 시도 한도(MAX_GENERATION_ATTEMPT)를 공유한다 — 재시도도 한 시도로 센다.
 *  3. 예산 가드를 그대로 통과해야 한다(reserveSpend → requireBudget). nsfw는 실지출에서 빠지지만
 *     실패 포함 상한(gross)에는 잡히므로, 거부가 쏟아지면 한도에서 저절로 멈춘다.
 *  4. 재제출은 씨앗을 바꾸고(attempt>1이면 난수 씨앗) 프롬프트에 안전 문구를 덧붙인다.
 * 규칙에 걸려 재시도하지 못하면 구간을 FAILED로 확정하고 사람이 내용을 고치게 한다.
 */
export function policyRetryLimit(): number {
  const raw = process.env.GEN_POLICY_RETRY_LIMIT;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  // 0을 주면 기능을 끈다. 음수·문자열은 기본값으로 돌린다.
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
}

export type PolicyRetryReason = 'LIMIT' | 'ATTEMPTS' | 'BUDGET' | 'ERROR' | 'DISABLED';

export interface PolicyRetryPlan {
  retrying: boolean;
  /** 이 구간에서 정책 거부로 끝난 생성 횟수(지금 실패한 건 포함) */
  rejections: number;
  /** 재제출한 시도 번호 */
  attempt?: number;
  reason?: PolicyRetryReason;
  detail?: string;
}

/**
 * 정책 거부 직후 호출한다. 재제출했으면 구간을 GENERATING으로 되돌려 놓고 true를 돌려준다.
 * 호출자(failJob)는 retrying이 false일 때만 구간을 종료 상태로 내린다.
 */
export async function retryAfterContentPolicy(args: {
  segmentId: string; projectId: string; orgId: string; traceId: string; failedAttempt: number;
}): Promise<PolicyRetryPlan> {
  const { segmentId, projectId, orgId, traceId, failedAttempt } = args;
  const log = childLogger({ traceId, segmentId });
  const limit = policyRetryLimit();

  const rejections = await prisma.generationJob.count({
    where: { segmentId, errorCode: ErrorCode.GEN_CONTENT_POLICY },
  });
  if (limit === 0) return { retrying: false, rejections, reason: 'DISABLED' };
  // 지금 실패한 건이 이미 세어져 있다 — 거부 1회면 재제출 1회가 남아 있다는 뜻이다.
  if (rejections > limit) {
    return {
      retrying: false, rejections, reason: 'LIMIT',
      detail: `제공자가 ${rejections}회 연속 정책 위반으로 거부했습니다 — 씨앗을 바꿔도 같은 판정입니다.`
        + ' 프롬프트의 의상·동작 표현을 바꾼 뒤 다시 실행하세요',
    };
  }

  const previous = await prisma.spendEntry.findUnique({
    where: { segmentId_attempt: { segmentId, attempt: failedAttempt } },
  });
  const amountCredits = previous ? Number(previous.amountCredits) : 0;

  try {
    const attempt = await prisma.$transaction(async (tx) => {
      await lockOrganizationSpend(tx, orgId);
      const segment = await tx.segment.findUnique({ where: { id: segmentId } });
      if (!segment) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '세그먼트 없음', { segmentId }, 404);
      // 시도 한도는 재시도도 함께 쓴다 — 정책 거부만 한도 밖에 두면 한 구간이 무한히 돈을 쓴다.
      if (segment.attemptCount >= MAX_GENERATION_ATTEMPT) {
        throw new CrezError(ErrorCode.PRJ_INVALID_STATE, `시도 한도(${MAX_GENERATION_ATTEMPT})를 다 썼습니다`,
          { retryReason: 'ATTEMPTS', attemptCount: segment.attemptCount }, 409);
      }
      const next = await nextGenerationAttempt(tx, segmentId, segment.attemptCount);
      await reserveSpend(tx, orgId, [{
        projectId, segmentId, attempt: next, amountCredits,
        dispatch: { payload: { reason: 'POLICY_RETRY', afterAttempt: failedAttempt }, priority: 5 },
      }]);
      await tx.segment.update({
        where: { id: segmentId }, data: { status: 'GENERATING', attemptCount: segment.attemptCount + 1 },
      });
      return next;
    }, { maxWait: 10000, timeout: 20000 });

    // 예약은 확정됐다. 큐 인계가 실패해도 reconciler가 같은 jobId로 다시 전달한다.
    await queues.generation.add(
      JOB_NAME.GENERATION_SUBMIT,
      { traceId, orgId, projectId, segmentId, attempt, policyRetry: rejections },
      {
        jobId: generationDispatchId(segmentId, attempt),
        priority: 5, removeOnComplete: false, removeOnFail: false,
        attempts: QUEUE_POLICY[QUEUE.GENERATION].attempts,
        backoff: { type: 'exponential', delay: QUEUE_POLICY[QUEUE.GENERATION].backoffMs },
      },
    );
    await prisma.spendEntry.update({
      where: { segmentId_attempt: { segmentId, attempt } }, data: { dispatchedAt: new Date() },
    }).catch(() => undefined);

    log.warn({ attempt, rejections, limit }, '정책 거부 — 씨앗과 안전 문구를 바꿔 자동 재제출한다');
    return { retrying: true, rejections, attempt };
  } catch (e) {
    const tagged = e instanceof CrezError
      ? (e.detail as { retryReason?: PolicyRetryReason } | null)?.retryReason
      : undefined;
    // 한도 초과가 아닌 PRJ_INVALID_STATE는 예산 가드(requireBudget)가 막은 것이다.
    const reason: PolicyRetryReason = tagged
      ?? (e instanceof CrezError && e.code === ErrorCode.PRJ_INVALID_STATE ? 'BUDGET' : 'ERROR');
    log.error({ err: String(e), reason }, '정책 거부 자동 재시도를 하지 못했다 — 구간을 실패로 확정한다');
    return {
      retrying: false, rejections, reason,
      detail: `자동 재시도를 하지 못했습니다: ${e instanceof CrezError ? e.message : String(e)}`,
    };
  }
}
