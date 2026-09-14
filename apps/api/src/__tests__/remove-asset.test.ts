import { describe, expect, it, vi } from 'vitest';
import { IdentityService, isAutoJudged } from '../modules/identity/identity.service';

const user = { id: 'u1', orgId: 'org1' } as never;
const asset = {
  id: 'a1', identityId: 'i1', assetType: 'FACE_IMAGE', captureSlot: 'LEFT_90',
  checksum: 'abc12345', storageKey: 'identities/i1/assets/a1/original.jpg', createdAt: new Date('2026-09-11T02:46:46Z'),
};

function setup(profilesAfterAsset: number) {
  const prisma = {
    identityAsset: {
      findFirst: vi.fn().mockResolvedValue(asset),
      update: vi.fn(),
      delete: vi.fn(),
    },
    identityProfile: { count: vi.fn().mockResolvedValue(profilesAfterAsset) },
  };
  const s3 = { delete: vi.fn() };
  const audit = { record: vi.fn() };
  const svc = new IdentityService(prisma as never, s3 as never, null as never, audit as never);
  return { svc, prisma, s3, audit };
}

describe('자산 삭제 (§6.1)', () => {
  it('프로파일 빌드에 쓰인 적이 없으면 DB 행과 스토리지 객체를 지우고 감사 로그에 남긴다', async () => {
    const { svc, prisma, s3, audit } = setup(0);

    await expect(svc.removeAsset(user, 'i1', 'a1', 't1')).resolves.toEqual({ ok: true, mode: 'DELETED' });

    expect(prisma.identityAsset.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
    expect(s3.delete).toHaveBeenCalledWith(asset.storageKey);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ASSET_DELETED',
      payload: expect.objectContaining({ checksum: asset.checksum, storageKey: asset.storageKey }),
    }));
  });

  it('자산 이후에 빌드된 프로파일이 있으면 재현성을 위해 비활성화만 한다', async () => {
    const { svc, prisma, s3 } = setup(1);

    await expect(svc.removeAsset(user, 'i1', 'a1', 't1')).resolves.toEqual({ ok: true, mode: 'DEACTIVATED' });

    expect(prisma.identityAsset.update).toHaveBeenCalledWith({
      where: { id: 'a1' }, data: { isUsable: false, rejectReason: 'DEACTIVATED' },
    });
    expect(prisma.identityAsset.delete).not.toHaveBeenCalled();
    expect(s3.delete).not.toHaveBeenCalled();
  });

  it('재검사는 워커가 제외한 자산만 되돌리고, 사용자가 뺀 자산은 건드리지 않는다', () => {
    expect(isAutoJudged({ isUsable: true, rejectReason: null, qualityScore: 0.6 })).toBe(true);
    expect(isAutoJudged({ isUsable: false, rejectReason: 'FACE_TOO_SMALL', qualityScore: 0.7 })).toBe(true);
    expect(isAutoJudged({ isUsable: false, rejectReason: 'DEACTIVATED', qualityScore: 0.7 })).toBe(false);
    // 사유 컬럼 도입 전 기록: 0점·하한 미달은 자동 제외, 점수가 충분한데 빠진 것은 사용자가 뺀 것
    expect(isAutoJudged({ isUsable: false, rejectReason: null, qualityScore: 0 })).toBe(true);
    expect(isAutoJudged({ isUsable: false, rejectReason: null, qualityScore: 0.15 })).toBe(true);
    expect(isAutoJudged({ isUsable: false, rejectReason: null, qualityScore: 0.7 })).toBe(false);
    expect(isAutoJudged({ isUsable: false, rejectReason: null, qualityScore: null })).toBe(false);
  });

  it('스토리지 삭제가 실패해도 DB 삭제는 성공으로 처리한다', async () => {
    const { svc, s3 } = setup(0);
    s3.delete.mockRejectedValue(new Error('minio down'));

    await expect(svc.removeAsset(user, 'i1', 'a1', 't1')).resolves.toEqual({ ok: true, mode: 'DELETED' });
  });
});
