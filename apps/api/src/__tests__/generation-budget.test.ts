import { describe, expect, it, vi } from 'vitest';
import { CrezError } from '@crez/shared';
import { SpendService } from '../modules/spend/spend.service';

/**
 * 월 지출 한도 (§12.1).
 * 제출한 요청은 제공자가 취소를 거부할 수 있어 되돌릴 수 없으므로 제출 전에 막는다.
 */
const user = { id: 'u1', orgId: 'org1' } as never;

const KLING = { costPerSecond: 0.25, capabilities: { billable: true, durations: [5, 10] } };
const MOCK = { costPerSecond: 0.02, capabilities: { modes: ['i2v'] } };

function job(over: Partial<{ status: string; costAmount: number | null; model: unknown; durationMs: number }> = {}) {
  const durationMs = over.durationMs ?? 5000;
  return {
    status: over.status ?? 'SUCCEEDED',
    costAmount: over.costAmount === undefined ? 1.25 : over.costAmount,
    model: over.model ?? KLING,
    segment: { startMs: 0, endMs: durationMs },
  };
}

function setup(opts: {
  policy?: { monthlyBudgetKrw?: number | null; creditUnitPriceKrw?: number | null; blockWhenUnpriced?: boolean } | null;
  jobs?: ReturnType<typeof job>[];
} = {}) {
  const prisma = {
    spendPolicy: {
      // null을 명시한 경우와 지정하지 않은 경우를 구분해야 한다 — ??로 합치면 null이 기본값으로 덮인다
      findUnique: vi.fn().mockResolvedValue(
        opts.policy === null ? null : {
          monthlyBudgetKrw: 'monthlyBudgetKrw' in (opts.policy ?? {}) ? opts.policy!.monthlyBudgetKrw : 100_000,
          creditUnitPriceKrw: 'creditUnitPriceKrw' in (opts.policy ?? {}) ? opts.policy!.creditUnitPriceKrw : 250,
          blockWhenUnpriced: opts.policy?.blockWhenUnpriced ?? true,
        },
      ),
      upsert: vi.fn().mockResolvedValue({
        monthlyBudgetKrw: 100_000, creditUnitPriceKrw: 250, blockWhenUnpriced: true,
      }),
    },
    generationJob: { findMany: vi.fn().mockResolvedValue(opts.jobs ?? []) },
  };
  const audit = { record: vi.fn() };
  return { svc: new SpendService(prisma as never, audit as never), prisma, audit };
}

describe('이번 달 사용량 집계', () => {
  it('확정된 비용을 더한다', async () => {
    const { svc } = setup({ jobs: [job(), job(), job()] });
    expect(await svc.monthToDateCredits('org1')).toBe(3.75);
  });

  it('진행 중인 작업은 예상 비용으로 센다 — 안 그러면 연달아 실행할 때 한도를 두 번 통과한다', async () => {
    const { svc } = setup({ jobs: [job({ status: 'SUBMITTED', costAmount: null })] });
    expect(await svc.monthToDateCredits('org1')).toBe(1.25);
  });

  it('진행 중 예상 비용도 제공자 길이로 계산한다 — 4초 구간은 5초로 올라간다', async () => {
    const { svc } = setup({ jobs: [job({ status: 'RUNNING', costAmount: null, durationMs: 4000 })] });
    expect(await svc.monthToDateCredits('org1')).toBe(1.25);
  });

  it('무료 모델은 세지 않는다', async () => {
    const { svc } = setup({ jobs: [job({ model: MOCK, costAmount: 0.1 })] });
    expect(await svc.monthToDateCredits('org1')).toBe(0);
  });

  it('끝났는데 비용이 없으면 과금되지 않은 것으로 본다', async () => {
    const { svc } = setup({ jobs: [job({ status: 'FAILED', costAmount: null })] });
    expect(await svc.monthToDateCredits('org1')).toBe(0);
  });
});

describe('한도 검사', () => {
  it('한도 안이면 통과한다', async () => {
    const { svc } = setup({ jobs: [job()] });   // 1.25크레딧 = 313원
    const v = await svc.assertWithinBudget('org1', 15);
    expect(v.allowed).toBe(true);
    expect(v.remainingKrw).toBe(99_687);
  });

  it('이번 실행까지 더해 한도를 넘으면 막는다', async () => {
    const { svc } = setup({ jobs: Array.from({ length: 300 }, () => job()) });  // 375크레딧 = 93,750원
    await expect(svc.assertWithinBudget('org1', 100)).rejects.toThrow(CrezError);
  });

  it('막을 때 남은 한도를 알려준다', async () => {
    const { svc } = setup({ jobs: Array.from({ length: 300 }, () => job()) });
    await svc.assertWithinBudget('org1', 100).then(
      () => { throw new Error('막아야 한다'); },
      (e: CrezError) => {
        expect(e.message).toContain('93,750원');
        expect(e.message).toContain('6,250원');
      },
    );
  });

  it('단가가 없으면 유료 생성을 막는다 — 얼마가 나갈지 모르는 채로 쓰지 않는다', async () => {
    const { svc } = setup({ policy: { creditUnitPriceKrw: null } });
    await expect(svc.assertWithinBudget('org1', 1)).rejects.toThrow(/단가/);
  });

  it('설정 자체가 없으면 막는다 — 기본이 차단이다', async () => {
    const { svc } = setup({ policy: null });
    await expect(svc.assertWithinBudget('org1', 1)).rejects.toThrow(CrezError);
  });
});

describe('정책 변경', () => {
  it('돈에 닿는 변경이라 감사에 남긴다', async () => {
    const { svc, audit } = setup();
    await svc.update(user, { creditUnitPriceKrw: 250 }, 't1');
    expect(audit.record.mock.calls[0][0].action).toBe('SPEND_POLICY_CHANGED');
    expect(audit.record.mock.calls[0][0].payload.after.creditUnitPriceKrw).toBe(250);
  });
});
