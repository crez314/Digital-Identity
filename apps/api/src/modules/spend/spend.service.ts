import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@crez/db';
import { CrezError, ErrorCode, snapDuration } from '@crez/shared';
import { checkBudget, monthStart, type BudgetVerdict, type SpendPolicy } from '@crez/engine';
import { PRISMA } from '../../common/prisma.module';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth.types';

/**
 * 조직 단위 지출 한도 (§12.1).
 *
 * 생성 실행 한 번이 수십 건의 유료 요청이고, 제출한 요청은 제공자가 취소를 거부할 수 있어
 * 되돌릴 수 없다. 사후 정산이 불가능하므로 제출 전에 막는다.
 */
@Injectable()
export class SpendService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  /** 설정이 없으면 "상한 없음 + 단가 없음"으로 본다 — 그 경우 유료 생성은 막힌다 */
  async policyOf(orgId: string): Promise<SpendPolicy> {
    const row = await this.prisma.spendPolicy.findUnique({ where: { orgId } });
    return {
      monthlyBudgetKrw: row?.monthlyBudgetKrw ? Number(row.monthlyBudgetKrw) : null,
      creditUnitPriceKrw: row?.creditUnitPriceKrw ? Number(row.creditUnitPriceKrw) : null,
      blockWhenUnpriced: row?.blockWhenUnpriced ?? true,
    };
  }

  /**
   * 이번 달 사용량(크레딧).
   *
   * 확정된 비용(cost_amount)만 세면 방금 제출한 수십 건이 아직 0으로 잡혀, 연달아 실행할 때
   * 한도를 두 번 통과한다. 그래서 진행 중인 작업은 예상 비용으로 함께 센다.
   *
   * 다만 이 값이 제공자 청구서와 같다는 보장은 없다 — 실패했는데 과금되는 경우와
   * 진행 중 취소가 거부된 경우는 여기에 잡히지 않는다(§12.1).
   */
  async monthToDateCredits(orgId: string, now = new Date()): Promise<number> {
    const since = monthStart(now);
    const jobs = await this.prisma.generationJob.findMany({
      where: {
        createdAt: { gte: since },
        segment: { project: { orgId } },
      },
      select: {
        status: true, costAmount: true,
        model: { select: { costPerSecond: true, capabilities: true } },
        segment: { select: { startMs: true, endMs: true } },
      },
    });

    let total = 0;
    for (const j of jobs) {
      const billable = (j.model.capabilities as { billable?: boolean } | null)?.billable === true;
      if (!billable) continue;

      if (j.costAmount !== null) {
        total += Number(j.costAmount);
        continue;
      }
      // 아직 끝나지 않은 작업은 예상 비용으로 센다. 끝난 작업인데 비용이 없으면 과금되지 않은 것으로 본다.
      if (!['QUEUED', 'SUBMITTED', 'RUNNING'].includes(j.status)) continue;
      const seconds = Math.max(0, j.segment.endMs - j.segment.startMs) / 1000;
      const durations = (j.model.capabilities as { durations?: number[] } | null)?.durations ?? null;
      total += snapDuration(durations, seconds) * Number(j.model.costPerSecond ?? 0);
    }
    return Number(total.toFixed(4));
  }

  /** 지출 정책과 이번 달 사용 현황 */
  async status(user: AuthUser) {
    const policy = await this.policyOf(user.orgId);
    const credits = await this.monthToDateCredits(user.orgId);
    const verdict = checkBudget({ policy, monthToDateCredits: credits, estimateCredits: 0 });
    return {
      policy,
      monthToDateCredits: credits,
      monthToDateKrw: verdict.monthToDateKrw,
      remainingKrw: verdict.remainingKrw,
      /** 단가를 몰라 유료 생성이 막혀 있는 상태인가 */
      blocked: verdict.reason === 'UNPRICED',
      since: monthStart().toISOString(),
    };
  }

  async update(
    user: AuthUser,
    input: { monthlyBudgetKrw?: number | null; creditUnitPriceKrw?: number | null; blockWhenUnpriced?: boolean },
    traceId: string,
  ) {
    const before = await this.policyOf(user.orgId);
    const row = await this.prisma.spendPolicy.upsert({
      where: { orgId: user.orgId },
      update: { ...input, updatedBy: user.id },
      create: { orgId: user.orgId, ...input, updatedBy: user.id },
    });

    // 한도를 바꾸는 일은 돈에 직접 닿는 결정이라 반드시 남긴다(§14.2)
    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'SPEND_POLICY_CHANGED',
      payload: { before, after: { ...input } },
      traceId,
    });
    return {
      monthlyBudgetKrw: row.monthlyBudgetKrw ? Number(row.monthlyBudgetKrw) : null,
      creditUnitPriceKrw: row.creditUnitPriceKrw ? Number(row.creditUnitPriceKrw) : null,
      blockWhenUnpriced: row.blockWhenUnpriced,
    };
  }

  /**
   * 유료 생성 제출 전 검사. 통과하지 못하면 한 건도 내보내지 않는다.
   * 무료 모델만 쓰는 실행은 호출하지 않는다 — 돈이 나가지 않는 실행까지 막으면 검증이 멈춘다.
   */
  async assertWithinBudget(orgId: string, estimateCredits: number): Promise<BudgetVerdict> {
    const policy = await this.policyOf(orgId);
    const monthToDateCredits = await this.monthToDateCredits(orgId);
    const verdict = checkBudget({ policy, monthToDateCredits, estimateCredits });
    if (!verdict.allowed) {
      throw new CrezError(
        ErrorCode.PRJ_INVALID_STATE,
        verdict.message ?? '지출 한도로 생성을 진행할 수 없습니다',
        { budget: verdict, monthToDateCredits, estimateCredits },
        409,
      );
    }
    return verdict;
  }
}
