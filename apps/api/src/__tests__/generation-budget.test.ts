import { describe, expect, it, vi } from 'vitest';
import { CrezError } from '@crez/shared';
import { SpendService } from '../modules/spend/spend.service';

/**
 * 월 지출 한도 (§12.1).
 * 제출한 요청은 제공자가 취소를 거부할 수 있어 되돌릴 수 없으므로 제출 전에 막는다.
 */
const user = { id: 'u1', orgId: 'org1' } as never;

function setup(opts: {
  policy?: { monthlyBudgetKrw?: number | null; creditUnitPriceKrw?: number | null; blockWhenUnpriced?: boolean } | null;
  credits?: number;
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
    spendEntry: { aggregate: vi.fn().mockResolvedValue({ _sum: { amountCredits: opts.credits ?? 0 } }) },
    $executeRaw: vi.fn(),
  };
  Object.assign(prisma, { $transaction: vi.fn((fn: (tx: typeof prisma) => unknown) => fn(prisma)) });
  const audit = { record: vi.fn() };
  return { svc: new SpendService(prisma as never, audit as never), prisma, audit };
}

describe('기본 월 한도', () => {
  it('설정이 없는 조직은 30만원으로 시작한다', async () => {
    const { svc } = setup({ policy: null });
    expect((await svc.policyOf('org1')).monthlyBudgetKrw).toBe(300000);
  });
  it('명시적인 0원은 무제한으로 바꾸지 않는다', async () => {
    const { svc } = setup({ policy: { monthlyBudgetKrw: 0 } });
    await expect(svc.assertWithinBudget('org1', 1)).rejects.toThrow(CrezError);
  });
  it('명시적인 무제한 설정은 보존한다', async () => {
    const { svc } = setup({ policy: { monthlyBudgetKrw: null } });
    expect((await svc.policyOf('org1')).monthlyBudgetKrw).toBeNull();
  });
});

describe('한도 검사', () => {
  it('한도 안이면 통과한다', async () => {
    const { svc } = setup({ credits: 1.25 });   // 1.25크레딧 = 313원
    const v = await svc.assertWithinBudget('org1', 15);
    expect(v.allowed).toBe(true);
    expect(v.remainingKrw).toBe(99_687);
  });

  it('이번 실행까지 더해 한도를 넘으면 막는다', async () => {
    const { svc } = setup({ credits: 375 });  // 375크레딧 = 93,750원
    await expect(svc.assertWithinBudget('org1', 100)).rejects.toThrow(CrezError);
  });

  it('막을 때 남은 한도를 알려준다', async () => {
    const { svc } = setup({ credits: 375 });
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
