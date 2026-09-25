import type { Prisma } from '@prisma/client';
import { checkBudget, monthStart, type SpendPolicy } from '@crez/engine';
import { CrezError, ErrorCode } from '@crez/shared';

export const DEFAULT_MONTHLY_BUDGET_KRW = 300_000;
type SpendDb = Pick<Prisma.TransactionClient, 'spendPolicy' | 'spendEntry'>;

/** 같은 조직의 검사·예약·제출·정산·정책 변경은 하나의 DB 잠금을 공유한다. */
export async function lockOrganizationSpend(tx: Prisma.TransactionClient, orgId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orgId}::text, 0))`;
}

export async function readSpendPolicy(db: SpendDb, orgId: string): Promise<SpendPolicy> {
  const row = await db.spendPolicy.findUnique({ where: { orgId } });
  return {
    monthlyBudgetKrw: !row ? DEFAULT_MONTHLY_BUDGET_KRW : row.monthlyBudgetKrw === null ? null : Number(row.monthlyBudgetKrw),
    creditUnitPriceKrw: row?.creditUnitPriceKrw == null ? null : Number(row.creditUnitPriceKrw),
    blockWhenUnpriced: row?.blockWhenUnpriced ?? true,
  };
}

/** 예약은 월이 바뀌어도 제출 전까지 유지한다. 프로젝트 삭제와 조인하지 않는다. */
export async function readSpendCredits(db: SpendDb, orgId: string, now = new Date(), excludeIds: string[] = []) {
  const total = await db.spendEntry.aggregate({
    where: {
      orgId, status: { not: 'RELEASED' }, id: { notIn: excludeIds },
      OR: [{ createdAt: { gte: monthStart(now) } }, { status: 'RESERVED' }],
    },
    _sum: { amountCredits: true },
  });
  return Number(total._sum.amountCredits ?? 0);
}

export function requireBudget(policy: SpendPolicy, credits: number, estimate: number) {
  const verdict = checkBudget({ policy, monthToDateCredits: credits, estimateCredits: estimate });
  if (estimate > 0 && !verdict.allowed) {
    throw new CrezError(ErrorCode.PRJ_INVALID_STATE, verdict.message ?? '월 지출 한도를 넘습니다',
      { budget: verdict, monthToDateCredits: credits, estimateCredits: estimate }, 409);
  }
  return verdict;
}

export interface SpendReservation {
  projectId: string;
  segmentId: string;
  attempt: number;
  amountCredits: number;
  dispatch?: Prisma.InputJsonValue;
}

/** 큐에 내보내기 전에 한 배치 전체를 원자적으로 예약한다. */
export async function reserveSpend(tx: Prisma.TransactionClient, orgId: string, entries: SpendReservation[]) {
  await lockOrganizationSpend(tx, orgId);
  const existing = await tx.spendEntry.findMany({
    where: { orgId, OR: entries.map(({ segmentId, attempt }) => ({ segmentId, attempt })) },
  });
  if (existing.some((e) => e.status !== 'RESERVED')) {
    throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '이미 제출하거나 취소한 생성 요청입니다', null, 409);
  }
  for (const entry of entries) {
    if (!Number.isFinite(entry.amountCredits) || entry.amountCredits < 0) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '유효한 생성 비용이 필요합니다', null, 409);
    }
    const previous = existing.find((e) => e.segmentId === entry.segmentId && e.attempt === entry.attempt);
    if (previous?.dispatch && entry.amountCredits > Number(previous.amountCredits) + 0.00005) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '생성 비용이 승인한 견적보다 커졌습니다. 견적을 다시 확인하세요', null, 409);
    }
  }
  const amount = Number(entries.reduce((sum, e) => sum + e.amountCredits, 0).toFixed(4));
  const verdict = requireBudget(await readSpendPolicy(tx, orgId),
    await readSpendCredits(tx, orgId, new Date(), existing.map((e) => e.id)), amount);
  for (const entry of entries) {
    await tx.spendEntry.upsert({
      where: { segmentId_attempt: { segmentId: entry.segmentId, attempt: entry.attempt } },
      create: { orgId, ...entry },
      update: { amountCredits: entry.amountCredits },
    });
  }
  return verdict;
}

/** 초기화 후에도 제출 전 실패·취소한 예약의 시도 번호를 재사용하지 않는다. */
export async function nextGenerationAttempt(tx: Pick<Prisma.TransactionClient, 'generationJob' | 'spendEntry'>,
  segmentId: string, attemptCount: number) {
  const [jobs, entries] = await Promise.all([
    tx.generationJob.aggregate({ where: { segmentId }, _max: { attempt: true } }),
    tx.spendEntry.aggregate({ where: { segmentId }, _max: { attempt: true } }),
  ]);
  return Math.max(jobs._max.attempt ?? 0, entries._max.attempt ?? 0, attemptCount) + 1;
}

export const generationDispatchId = (segmentId: string, attempt: number) => `submit-${segmentId}-${attempt}`;
