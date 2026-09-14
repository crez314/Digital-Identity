import { describe, expect, it, vi } from 'vitest';
import { PromptReferenceUploadRequest } from '@crez/contracts';
import { ErrorCode } from '@crez/shared';
import { ProjectService } from '../modules/project/project.service';

const user = { id: 'u1', orgId: 'org1' } as never;
const ref = {
  id: 'r1', segmentId: 's1', kind: 'OUTFIT', slotIndex: 0, fileName: 'outfit.jpg',
  storageKey: 'projects/p1/segments/s1/references/r1.jpg', checksum: 'abcd1234',
};

function setup(opts: { referenceCount?: number; usedByJobs?: number; attached?: number } = {}) {
  const prisma = {
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1', orgId: 'org1', status: 'READY' }) },
    segment: { findFirst: vi.fn().mockResolvedValue({ id: 's1', projectId: 'p1', segmentIndex: 0 }) },
    segmentReference: {
      count: vi.fn().mockResolvedValue(opts.referenceCount ?? opts.attached ?? 0),
      create: vi.fn(), update: vi.fn(), delete: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(ref),
    },
    generationJob: { count: vi.fn().mockResolvedValue(opts.usedByJobs ?? 0) },
  };
  const s3 = { presignPut: vi.fn().mockResolvedValue({ url: 'https://minio/put', expiresIn: 900 }), delete: vi.fn() };
  const audit = { record: vi.fn() };
  const svc = new ProjectService(prisma as never, s3 as never, null as never, audit as never, null as never, null as never);
  return { svc, prisma, s3, audit };
}

describe('프롬프트 참고 이미지 (배경·의상·헤어)', () => {
  it('요청 계약: 배경은 위치를 가질 수 없고, 이미지 형식만 받는다', () => {
    expect(PromptReferenceUploadRequest.safeParse({ kind: 'BACKGROUND', slotIndex: 0, contentType: 'image/jpeg', fileName: 'bg.jpg' }).success).toBe(false);
    expect(PromptReferenceUploadRequest.safeParse({ kind: 'BACKGROUND', contentType: 'image/jpeg', fileName: 'bg.jpg' }).success).toBe(true);
    expect(PromptReferenceUploadRequest.safeParse({ kind: 'HAIR', slotIndex: 1, contentType: 'image/heic', fileName: 'h.heic' }).success).toBe(false);
  });

  it('업로드 URL을 발급하고 확정 전까지 pending으로 둔다', async () => {
    const { svc, prisma } = setup();
    const res = await svc.createReferenceUploadUrl(user, 'p1', 's1', { kind: 'HAIR', slotIndex: 1, contentType: 'image/png', fileName: 'hair.png' });
    expect(res.uploadUrl).toBe('https://minio/put');
    expect(prisma.segmentReference.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'HAIR', slotIndex: 1, checksum: 'pending',
        storageKey: `projects/p1/segments/s1/references/${res.referenceId}.png`,
      }),
    });
  });

  it('구간당 6장을 넘기면 거절한다', async () => {
    const { svc, prisma } = setup({ referenceCount: 6 });
    await expect(svc.createReferenceUploadUrl(user, 'p1', 's1', { kind: 'BACKGROUND', contentType: 'image/jpeg', fileName: 'bg.jpg' }))
      .rejects.toMatchObject({ code: ErrorCode.PRJ_INVALID_STATE, httpStatus: 409 });
    expect(prisma.segmentReference.create).not.toHaveBeenCalled();
  });

  it('생성에 쓰인 적 없는 이미지는 DB와 스토리지에서 지운다', async () => {
    const { svc, prisma, s3, audit } = setup({ usedByJobs: 0 });
    await expect(svc.removeReference(user, 'p1', 's1', 'r1', 't1')).resolves.toEqual({ ok: true, mode: 'DELETED' });
    expect(prisma.segmentReference.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(s3.delete).toHaveBeenCalledWith(ref.storageKey);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'SEGMENT_REFERENCE_REMOVED', payload: expect.objectContaining({ mode: 'DELETED', checksum: ref.checksum }),
    }));
  });

  it('생성 요청에 들어간 이미지는 파일을 보존하고 이후 생성에서만 뺀다', async () => {
    const { svc, prisma, s3 } = setup({ usedByJobs: 2 });
    await expect(svc.removeReference(user, 'p1', 's1', 'r1', 't1')).resolves.toEqual({ ok: true, mode: 'DEACTIVATED' });
    expect(prisma.segmentReference.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { active: false } });
    expect(prisma.segmentReference.delete).not.toHaveBeenCalled();
    expect(s3.delete).not.toHaveBeenCalled();
  });

  it('참고 이미지가 붙어 있으면 구간을 다시 정의하지 않는다 — 세그먼트와 함께 사라지기 때문이다', async () => {
    const { svc } = setup({ attached: 2 });
    await expect(svc.setScenes(user, 'p1', [{ sceneIndex: 0, startMs: 0, endMs: 5000 }]))
      .rejects.toMatchObject({ code: ErrorCode.PRJ_INVALID_STATE, httpStatus: 409 });
  });
});
