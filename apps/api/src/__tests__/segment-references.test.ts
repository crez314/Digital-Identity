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

/**
 * 시작 프레임 지정 (§12.1).
 *
 * image-to-video의 시작 이미지는 1장뿐이라, 의상을 바꾸려면 그 1장을 사람이 지정해야 한다.
 * 첨부(OUTFIT)로 넘기면 인물 레퍼런스가 그 자리를 차지해 통째로 버려진다 — 그래서 별도 종류다.
 */
describe('시작 프레임 지정', () => {
  it('요청 계약: 위치를 지정할 수 없다 — 구간 전체의 첫 장면이다', () => {
    const base = { kind: 'START_FRAME' as const, contentType: 'image/jpeg' as const, fileName: 's.jpg' };
    expect(PromptReferenceUploadRequest.safeParse(base).success).toBe(true);
    expect(PromptReferenceUploadRequest.safeParse({ ...base, slotIndex: 0 }).success).toBe(true);
    expect(PromptReferenceUploadRequest.safeParse({ ...base, slotIndex: 1 }).success).toBe(false);
  });

  it('구간당 한 장만 받는다 — 두 장이면 어느 것이 쓰였는지 설명할 수 없다', async () => {
    const { svc, prisma } = setup();
    prisma.segmentReference.count = vi.fn()
      .mockResolvedValueOnce(1)   // 전체 첨부 수 — 한도 미만
      .mockResolvedValueOnce(1);  // 이미 있는 START_FRAME
    await expect(
      svc.createReferenceUploadUrl(user, 'p1', 's1', { kind: 'START_FRAME', contentType: 'image/jpeg', fileName: 's.jpg' }),
    ).rejects.toMatchObject({ code: ErrorCode.PRJ_INVALID_STATE, httpStatus: 409 });
    expect(prisma.segmentReference.create).not.toHaveBeenCalled();
  });
});
