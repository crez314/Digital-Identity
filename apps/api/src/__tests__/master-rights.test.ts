import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@crez/shared';
import { MasterService } from '../modules/master/master.service';
import { RightsService } from '../modules/rights/rights.service';

const user = { id: 'u1', orgId: 'org1' } as never;
const EUN = 'identity-eun';
const DAON = 'identity-daon';

function rightsRow(identityId: string, consentStatus: string) {
  return {
    identityId, consentStatus, createdAt: new Date(),
    startsAt: new Date('2026-01-01'), expiresAt: null,
    syntheticPermitted: true, allowedUsage: ['MV'], restrictedUsage: [], territories: [],
  };
}

// 권리 판정은 실제 RightsService로 돌리고 DB만 흉내 낸다 — 게이트 연결 자체를 검증하려는 것이다.
function setup(consent: Record<string, string>) {
  const prisma = {
    project: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'p1', title: 'E2E', projectType: 'MV', config: {},
        cast: [EUN, DAON].map((identityId) => ({ identityId, identity: { code: identityId }, profile: { version: 1 } })),
      }),
    },
    identityRights: {
      findMany: vi.fn().mockResolvedValue(Object.entries(consent).map(([id, s]) => rightsRow(id, s))),
    },
    rightsCheck: { create: vi.fn().mockResolvedValue({ id: 'check1' }) },
    segment: { findMany: vi.fn().mockResolvedValue([]) },
    masterVideo: { findFirst: vi.fn(), create: vi.fn() },
  };
  const audit = { record: vi.fn() };
  const rights = new RightsService(prisma as never, audit as never, null as never);
  const svc = new MasterService(prisma as never, null as never, audit as never, null as never, rights);
  return { svc, prisma };
}

describe('마스터 결합 권리 게이트 (§14.1)', () => {
  it('consent가 철회된 인물이 캐스트에 있으면 마스터를 만들지 않는다', async () => {
    const { svc, prisma } = setup({ [EUN]: 'REVOKED', [DAON]: 'GRANTED' });

    await expect(
      svc.createMaster(user, 'p1', { normalizeColor: false, normalizeTiming: false }, 't1'),
    ).rejects.toMatchObject({ code: ErrorCode.RGT_CONSENT_INVALID, httpStatus: 403 });

    expect(prisma.segment.findMany).not.toHaveBeenCalled();
    expect(prisma.masterVideo.create).not.toHaveBeenCalled();
  });

  it('전원 허용이면 게이트를 통과해 다음 검증으로 넘어간다', async () => {
    const { svc, prisma } = setup({ [EUN]: 'GRANTED', [DAON]: 'GRANTED' });

    // 세그먼트가 없으므로 PRJ_INVALID_STATE로 멈추지만, 권리 게이트는 통과했다는 뜻이다.
    await expect(
      svc.createMaster(user, 'p1', { normalizeColor: false, normalizeTiming: false }, 't1'),
    ).rejects.toMatchObject({ code: ErrorCode.PRJ_INVALID_STATE });
    expect(prisma.rightsCheck.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ gate: 'GENERATION', allowed: true }) }),
    );
  });
});
