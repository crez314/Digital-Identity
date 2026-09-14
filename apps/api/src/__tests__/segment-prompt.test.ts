import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@crez/shared';
import { ProjectService } from '../modules/project/project.service';

const user = { id: 'u1', orgId: 'org1' } as never;

function setup(opts: { status?: string; segmentPrompt?: string | null; segmentExists?: boolean } = {}) {
  const prisma = {
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1', orgId: 'org1', status: opts.status ?? 'READY' }) },
    segment: {
      findFirst: vi.fn().mockResolvedValue(
        opts.segmentExists === false ? null : { id: 's1', projectId: 'p1', segmentIndex: 2, prompt: opts.segmentPrompt ?? null },
      ),
      update: vi.fn(),
    },
  };
  const audit = { record: vi.fn() };
  const svc = new ProjectService(prisma as never, null as never, null as never, audit as never, null as never, null as never);
  return { svc, prisma, audit };
}

describe('세그먼트 프롬프트 수정 (§6.3)', () => {
  it('앞뒤 공백을 걷어 저장하고 변경 전후를 감사 로그에 남긴다', async () => {
    const { svc, prisma, audit } = setup({ segmentPrompt: '무대' });

    await expect(svc.updateSegmentPrompt(user, 'p1', 's1', { prompt: '  카메라를 향해 걸어오는 장면  ' }, 't1'))
      .resolves.toEqual({ id: 's1', prompt: '카메라를 향해 걸어오는 장면' });

    expect(prisma.segment.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { prompt: '카메라를 향해 걸어오는 장면' } });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'SEGMENT_PROMPT_CHANGED',
      payload: { segmentId: 's1', segmentIndex: 2, before: '무대', after: '카메라를 향해 걸어오는 장면' },
    }));
  });

  it('비우면 null로 저장해 씬 프롬프트를 쓰게 한다', async () => {
    const { svc, prisma } = setup({ segmentPrompt: '무대' });
    await svc.updateSegmentPrompt(user, 'p1', 's1', { prompt: '   ' }, 't1');
    expect(prisma.segment.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { prompt: null } });
  });

  it('값이 그대로면 저장·감사 기록을 하지 않는다', async () => {
    const { svc, prisma, audit } = setup({ segmentPrompt: '무대' });
    await svc.updateSegmentPrompt(user, 'p1', 's1', { prompt: '무대' }, 't1');
    expect(prisma.segment.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('보관된 프로젝트나 없는 세그먼트는 거절한다', async () => {
    await expect(setup({ status: 'ARCHIVED' }).svc.updateSegmentPrompt(user, 'p1', 's1', { prompt: 'x' }, 't1'))
      .rejects.toMatchObject({ code: ErrorCode.PRJ_INVALID_STATE });
    await expect(setup({ segmentExists: false }).svc.updateSegmentPrompt(user, 'p1', 's1', { prompt: 'x' }, 't1'))
      .rejects.toMatchObject({ code: ErrorCode.PRJ_NOT_FOUND, httpStatus: 404 });
  });
});
