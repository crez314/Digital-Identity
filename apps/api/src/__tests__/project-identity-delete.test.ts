import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@crez/shared';
import { ProjectService } from '../modules/project/project.service';
import { IdentityService } from '../modules/identity/identity.service';

const user = { id: 'u1', orgId: 'org1' } as never;
const veoReference = { code: 'higgsfield-veo31-reference', status: 'ACTIVE', capabilities: { modes: ['reference'] } };

function projectSetup(opts: { status?: string; config?: Record<string, unknown>; model?: unknown; inFlight?: number } = {}) {
  const project = { id: 'p1', orgId: 'org1', title: 'HF 테스트', projectType: 'MV', status: opts.status ?? 'READY', config: opts.config ?? { requiredMode: 'pose-guided' }, createdAt: new Date() };
  const prisma = {
    project: {
      findFirst: vi.fn().mockResolvedValue(project),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...project, ...data })),
      delete: vi.fn(),
      create: vi.fn().mockResolvedValue(project),
    },
    aiModel: { findUnique: vi.fn().mockResolvedValue(opts.model === undefined ? veoReference : opts.model) },
    projectCast: { findMany: vi.fn().mockResolvedValue([{ slotIndex: 0, identityId: 'i1', identity: { code: 'CRZ-A008' }, profile: { version: 1 } }]) },
    // status 조건이 있으면 진행 중 구간 수, 없으면 전체 구간 수
    segment: { count: vi.fn().mockImplementation(({ where }) => Promise.resolve(where.status ? (opts.inFlight ?? 0) : 2)) },
    generationJob: { count: vi.fn().mockResolvedValue(6) },
    masterVideo: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const s3 = { deletePrefix: vi.fn().mockResolvedValue(7) };
  const queue = { cancelByProject: vi.fn().mockResolvedValue(1) };
  const audit = { record: vi.fn() };
  const svc = new ProjectService(prisma as never, s3 as never, queue as never, audit as never, null as never, null as never);
  return { svc, prisma, s3, queue, audit };
}

describe('프로젝트 생성 설정 (Higgsfield 지정)', () => {
  it('생성 전이면 방식·지정 모델을 바꾸고 감사 로그를 남긴다', async () => {
    const { svc, prisma, audit } = projectSetup();
    await svc.update(user, 'p1', { config: { requiredMode: 'reference', preferredModel: 'higgsfield-veo31-reference' } }, 't1');
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { config: { requiredMode: 'reference', preferredModel: 'higgsfield-veo31-reference' } },
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'PROJECT_UPDATED' }));
  });

  it('지정 모델이 그 방식을 지원하지 않거나 꺼져 있으면 저장하지 않는다', async () => {
    const wrongMode = projectSetup();
    await expect(wrongMode.svc.update(user, 'p1', { config: { requiredMode: 'i2v', preferredModel: 'higgsfield-veo31-reference' } }, 't1'))
      .rejects.toMatchObject({ code: ErrorCode.PRJ_INVALID_STATE, httpStatus: 422 });
    const disabled = projectSetup({ model: { ...veoReference, status: 'DISABLED' } });
    await expect(disabled.svc.create(user, { title: 'x', projectType: 'MV', config: { requiredMode: 'reference', preferredModel: 'higgsfield-veo31-reference' } }))
      .rejects.toMatchObject({ httpStatus: 422 });
    expect(wrongMode.prisma.project.update).not.toHaveBeenCalled();
  });

  it('방식만 바꿔도 기존 지정 모델과 맞는지 다시 검사한다', async () => {
    const { svc } = projectSetup({ config: { requiredMode: 'reference', preferredModel: 'higgsfield-veo31-reference' } });
    await expect(svc.update(user, 'p1', { config: { requiredMode: 'pose-guided' } }, 't1')).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('이미 생성한 프로젝트의 생성 설정은 바꾸지 않는다', async () => {
    const { svc } = projectSetup({ status: 'COMPLETED' });
    await expect(svc.update(user, 'p1', { config: { resolution: '720p' } }, 't1')).rejects.toMatchObject({ httpStatus: 409 });
  });
});

describe('프로젝트 삭제', () => {
  it('생성·QC가 진행 중인 구간이 있으면 거절한다', async () => {
    const { svc, prisma } = projectSetup({ status: 'RUNNING', inFlight: 1 });
    await expect(svc.remove(user, 'p1', 't1')).rejects.toMatchObject({ code: ErrorCode.PRJ_INVALID_STATE, httpStatus: 409 });
    expect(prisma.project.delete).not.toHaveBeenCalled();
  });

  it('상태가 RUNNING이어도 실제로 도는 작업이 없으면 삭제한다 — 모델 선택 실패·취소 후 갇히지 않게', async () => {
    const { svc, prisma } = projectSetup({ status: 'RUNNING', inFlight: 0 });
    await expect(svc.remove(user, 'p1', 't1')).resolves.toMatchObject({ ok: true });
    expect(prisma.project.delete).toHaveBeenCalled();
  });

  it('큐를 비우고 DB·스토리지를 지우며, 무엇을 지웠는지 감사 로그에 남긴다', async () => {
    const { svc, prisma, s3, queue, audit } = projectSetup({ status: 'COMPLETED' });
    await expect(svc.remove(user, 'p1', 't1')).resolves.toEqual({ ok: true, deletedObjects: 7 });
    expect(queue.cancelByProject).toHaveBeenCalledWith('p1');
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    expect(s3.deletePrefix).toHaveBeenCalledWith('projects/p1/');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'PROJECT_DELETED',
      payload: expect.objectContaining({ title: 'HF 테스트', segmentCount: 2, generationJobCount: 6, cast: [expect.objectContaining({ code: 'CRZ-A008' })] }),
    }));
  });
});

describe('Identity 삭제', () => {
  function identitySetup(casts: unknown[]) {
    const prisma = {
      identity: { findFirst: vi.fn().mockResolvedValue({ id: 'i1', orgId: 'org1', code: 'CRZ-A008', displayName: '김지민test', status: 'ACTIVE' }), delete: vi.fn() },
      projectCast: { findMany: vi.fn().mockResolvedValue(casts) },
      identityProfile: { findMany: vi.fn().mockResolvedValue([{ version: 1, status: 'ACTIVE' }]) },
      identityAsset: { count: vi.fn().mockResolvedValue(11) },
      identityRights: { findMany: vi.fn().mockResolvedValue([{ consentStatus: 'GRANTED', createdAt: new Date() }]) },
    };
    const s3 = { deletePrefix: vi.fn().mockResolvedValue(11) };
    const audit = { record: vi.fn() };
    const svc = new IdentityService(prisma as never, s3 as never, null as never, audit as never);
    return { svc, prisma, s3, audit };
  }

  it('캐스팅된 프로젝트가 있으면 어느 프로젝트인지 알려주고 거절한다', async () => {
    const { svc, prisma } = identitySetup([{ project: { id: 'p1', title: '김지민test', status: 'READY' } }]);
    await expect(svc.remove(user, 'i1', 't1')).rejects.toMatchObject({
      httpStatus: 409, message: expect.stringContaining("'김지민test'"),
    });
    expect(prisma.identity.delete).not.toHaveBeenCalled();
  });

  it('캐스팅이 없으면 DB·스토리지를 지우고 감사 로그에 요약을 남긴다', async () => {
    const { svc, prisma, s3, audit } = identitySetup([]);
    await expect(svc.remove(user, 'i1', 't1')).resolves.toEqual({ ok: true, deletedObjects: 11 });
    expect(prisma.identity.delete).toHaveBeenCalledWith({ where: { id: 'i1' } });
    expect(s3.deletePrefix).toHaveBeenCalledWith('identities/i1/');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'IDENTITY_DELETED', payload: expect.objectContaining({ code: 'CRZ-A008', assetCount: 11, latestConsent: 'GRANTED' }),
    }));
  });
});
