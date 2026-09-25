import { Inject, Injectable } from '@nestjs/common';
import { lockOrganizationSpend, readSpendCredits, readSpendPolicy, requireBudget, type PrismaClient } from '@crez/db';
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

  /** 미설정 조직의 기본 월 한도는 30만원. 단가 미설정 시 유료 생성은 차단한다. */
  policyOf(orgId: string): Promise<SpendPolicy> {
    return readSpendPolicy(this.prisma, orgId);
  }

  /** 프로젝트가 삭제되어도 독립 원장의 예약·제출·확정 비용을 센다. */
  monthToDateCredits(orgId: string, now = new Date()): Promise<number> {
    return readSpendCredits(this.prisma, orgId, now);
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
    const { before, row } = await this.prisma.$transaction(async (tx) => {
      await lockOrganizationSpend(tx, user.orgId);
      const before = await readSpendPolicy(tx, user.orgId);
      const row = await tx.spendPolicy.upsert({
        where: { orgId: user.orgId },
        update: { ...input, updatedBy: user.id },
        create: { orgId: user.orgId, ...input, updatedBy: user.id },
      });
      return { before, row };
    });

    // 한도를 바꾸는 일은 돈에 직접 닿는 결정이라 반드시 남긴다(§14.2)
    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'SPEND_POLICY_CHANGED',
      payload: { before, after: { ...input } },
      traceId,
    });
    return {
      monthlyBudgetKrw: row.monthlyBudgetKrw === null ? null : Number(row.monthlyBudgetKrw),
      creditUnitPriceKrw: row.creditUnitPriceKrw === null ? null : Number(row.creditUnitPriceKrw),
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
    return requireBudget(policy, monthToDateCredits, estimateCredits);
  }
}
