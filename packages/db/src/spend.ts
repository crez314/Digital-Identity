import type { Prisma } from '@prisma/client';
import { checkBudget, monthStart, type SpendPolicy } from '@crez/engine';
import { CrezError, ErrorCode } from '@crez/shared';

export const DEFAULT_MONTHLY_BUDGET_KRW = 300_000;
/** 실패한 생성까지 포함한 월 상한 — 실패는 과금되지 않지만 쏟아지면 무언가 잘못된 것이다 */
export const DEFAULT_GROSS_MONTHLY_BUDGET_KRW = 500_000;

/**
 * 원장 상태.
 *  RESERVED  큐에 넣기 전 예약 — 아직 제공자에 가지 않았다
 *  SUBMITTED 제공자에 보냈다. 결과를 모르는 동안에도 돈이 나갈 수 있다고 본다
 *  SETTLED   성공해서 실제 비용이 확정됐다
 *  FAILED    제공자가 실패를 **확정**했다. 제공자는 실패를 과금하지 않으므로 실지출에서는 뺀다
 *  RELEASED  제출 전에 취소·실패해 돈이 나가지 않았다
 *
 * 제출은 했는데 결과를 모르는 경우(타임아웃 등)는 FAILED가 아니라 SUBMITTED로 남긴다 —
 * 접수됐을 수 있으므로 실지출에 계속 포함한다.
 */
export const SPEND_STATUS = ['RESERVED', 'SUBMITTED', 'SETTLED', 'FAILED', 'RELEASED'] as const;
type SpendDb = Pick<Prisma.TransactionClient, 'spendPolicy' | 'spendEntry'>;

/** 같은 조직의 검사·예약·제출·정산·정책 변경은 하나의 DB 잠금을 공유한다. */
export async function lockOrganizationSpend(tx: Prisma.TransactionClient, orgId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orgId}::text, 0))`;
}

export async function readSpendPolicy(db: SpendDb, orgId: string): Promise<SpendPolicy> {
  const row = await db.spendPolicy.findUnique({ where: { orgId } });
  return {
    monthlyBudgetKrw: !row ? DEFAULT_MONTHLY_BUDGET_KRW : row.monthlyBudgetKrw === null ? null : Number(row.monthlyBudgetKrw),
    monthlyGrossBudgetKrw: !row
      ? DEFAULT_GROSS_MONTHLY_BUDGET_KRW
      : row.monthlyGrossBudgetKrw === null ? null : Number(row.monthlyGrossBudgetKrw),
    creditUnitPriceKrw: row?.creditUnitPriceKrw == null ? null : Number(row.creditUnitPriceKrw),
    blockWhenUnpriced: row?.blockWhenUnpriced ?? true,
  };
}

export interface SpendLedger {
  /** 실제로 나갈 돈 — 실패로 확정된 생성은 뺀다 */
  net: number;
  /** 실패까지 포함한 총량 */
  gross: number;
}

/**
 * 이번 달 사용량을 두 가지로 집계한다.
 * 예약은 월이 바뀌어도 제출 전까지 유지한다. 프로젝트 삭제와 조인하지 않는다(원장은 삭제 후에도 남는다).
 */
export async function readSpendLedger(
  db: SpendDb, orgId: string, now = new Date(), excludeIds: string[] = [],
): Promise<SpendLedger> {
  const rows = await db.spendEntry.groupBy({
    by: ['status'],
    where: {
      orgId, status: { not: 'RELEASED' }, id: { notIn: excludeIds },
      OR: [{ createdAt: { gte: monthStart(now) } }, { status: 'RESERVED' }],
    },
    _sum: { amountCredits: true },
  });
  let net = 0;
  let gross = 0;
  for (const row of rows) {
    const amount = Number(row._sum.amountCredits ?? 0);
    gross += amount;
    if (row.status !== 'FAILED') net += amount;
  }
  return { net: Number(net.toFixed(4)), gross: Number(gross.toFixed(4)) };
}

/** 실지출(실패 제외) 크레딧. 실패 포함 값까지 필요하면 readSpendLedger를 쓴다. */
export async function readSpendCredits(db: SpendDb, orgId: string, now = new Date(), excludeIds: string[] = []) {
  return (await readSpendLedger(db, orgId, now, excludeIds)).net;
}

/**
 * 제출로 이어지지 않은 채 오래 남은 예약을 푼다.
 *
 * 예약은 "제출 전까지 유지"가 원칙이라 월이 바뀌어도 계속 합산된다(readSpendLedger). 그래서 큐가
 * 작업을 잃어버리거나 워커가 죽어 생긴 고아 예약은 **영구히** 한도를 깎았고, 되돌릴 수단이 없었다.
 * 생성은 몇 분이면 끝나므로, 살아 있는 job이 없는 채로 이 시간을 넘긴 예약은 고아로 본다.
 *
 * 제공자에 이미 나간 예약(SUBMITTED)은 손대지 않는다 — 돈이 나갔을 수 있다.
 */
export async function releaseStaleReservations(
  db: Pick<Prisma.TransactionClient, 'spendEntry' | 'generationJob'>,
  olderThan: Date,
  limit = 200,
): Promise<Array<{ id: string; orgId: string; segmentId: string; attempt: number; amountCredits: number }>> {
  const candidates = await db.spendEntry.findMany({
    where: { status: 'RESERVED', createdAt: { lt: olderThan } },
    orderBy: { createdAt: 'asc' }, take: limit,
  });
  if (candidates.length === 0) return [];
  // 아직 돌고 있는 작업의 예약은 건드리지 않는다.
  const live = await db.generationJob.findMany({
    where: {
      status: { in: ['QUEUED', 'SUBMITTED', 'RUNNING'] },
      OR: candidates.map((c) => ({ segmentId: c.segmentId, attempt: c.attempt })),
    },
    select: { segmentId: true, attempt: true },
  });
  const liveKey = new Set(live.map((j) => `${j.segmentId}:${j.attempt}`));
  const orphans = candidates.filter((c) => !liveKey.has(`${c.segmentId}:${c.attempt}`));
  if (orphans.length === 0) return [];
  await db.spendEntry.updateMany({
    where: { id: { in: orphans.map((o) => o.id) }, status: 'RESERVED' },
    data: { status: 'RELEASED' },
  });
  return orphans.map((o) => ({
    id: o.id, orgId: o.orgId, segmentId: o.segmentId, attempt: o.attempt, amountCredits: Number(o.amountCredits),
  }));
}

/**
 * 제공자가 실패를 확정한 시도를 원장에서 실패로 표시한다 — 실지출에서는 빠지고 실패 포함 총량에는 남는다.
 * 접수 여부를 모르는 실패(제출 중 오류·폴링 timeout)에는 쓰지 않는다. 그 경우는 돈이 나갔을 수 있다.
 */
export async function markSpendFailed(
  db: Pick<Prisma.TransactionClient, 'spendEntry'>, orgId: string, segmentId: string, attempt: number,
) {
  return db.spendEntry.updateMany({
    where: { orgId, segmentId, attempt, status: 'SUBMITTED' },
    data: { status: 'FAILED' },
  });
}

export function requireBudget(policy: SpendPolicy, ledger: SpendLedger, estimate: number) {
  const verdict = checkBudget({
    policy, monthToDateCredits: ledger.net, grossMonthToDateCredits: ledger.gross, estimateCredits: estimate,
  });
  if (estimate > 0 && !verdict.allowed) {
    throw new CrezError(ErrorCode.PRJ_INVALID_STATE, verdict.message ?? '월 지출 한도를 넘습니다',
      { budget: verdict, monthToDateCredits: ledger.net, grossMonthToDateCredits: ledger.gross, estimateCredits: estimate },
      409);
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
    await readSpendLedger(tx, orgId, new Date(), existing.map((e) => e.id)), amount);
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
