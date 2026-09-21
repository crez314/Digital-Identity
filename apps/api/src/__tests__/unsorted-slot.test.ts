import { describe, expect, it, vi } from 'vitest';
import { IdentityService } from '../modules/identity/identity.service';

/**
 * 자동 분류에 실패한 사진(UNSORTED)의 구제 경로를 고정한다.
 *
 * 워커는 분류하지 못한 사진을 captureSlot=null, assetType='UNSORTED'로 남기고
 * 화면은 "슬롯을 지정해야 하는 사진"으로 띄운다. 그 화면이 동작하려면 서버가
 * 썸네일을 발급하고 슬롯 이동을 받아 줘야 한다 — 한쪽이라도 막히면 지정할 수단이 없다.
 */
const user = { id: 'u1', orgId: 'org1' } as never;
const unsorted = {
  id: 'a1', identityId: 'i1', assetType: 'UNSORTED', captureSlot: null,
  checksum: 'abc12345', storageKey: 'identities/i1/assets/a1/original.jpg',
  isUsable: false, qualityScore: null, rejectReason: 'UNCLASSIFIED',
  qualityDetail: { classifierReason: '반신 사진이라 분류할 수 없습니다' },
  expression: null, width: null, height: null, durationMs: null,
  createdAt: new Date('2026-09-21T02:46:46Z'),
};

function setup(asset: Record<string, unknown> = unsorted) {
  const prisma = {
    identity: { findFirst: vi.fn().mockResolvedValue({ id: 'i1', orgId: 'org1' }) },
    identityAsset: {
      findFirst: vi.fn().mockResolvedValue(asset),
      findMany: vi.fn().mockResolvedValue([asset]),
      update: vi.fn(),
    },
    identityProfile: { count: vi.fn().mockResolvedValue(0) },
  };
  const s3 = { presignGet: vi.fn().mockResolvedValue({ url: 'https://s3.example/a1' }) };
  const queue = { add: vi.fn() };
  const audit = { record: vi.fn() };
  return { svc: new IdentityService(prisma as never, s3 as never, queue as never, audit as never), prisma, s3, queue };
}

describe('분류 실패 사진의 슬롯 지정 (§8.1 확장)', () => {
  it('사람이 슬롯을 지정할 수 있고, 사람이 정했다는 표시를 남겨 재분류가 되돌리지 않는다', async () => {
    const { svc, prisma, queue } = setup();

    await expect(svc.moveAssetSlot(user, 'i1', 'a1', 'LEFT_45', 't1')).resolves.toMatchObject({
      captureSlot: 'LEFT_45', assetType: 'FACE_IMAGE', requeued: true,
    });

    expect(prisma.identityAsset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: expect.objectContaining({
        captureSlot: 'LEFT_45', assetType: 'FACE_IMAGE', qualityDetail: { manualSlot: true },
      }),
    });
    expect(queue.add).toHaveBeenCalled();
  });

  it('전신 슬롯으로 지정하면 자산 종류도 함께 바뀐다 — 판정 기준이 다르다', async () => {
    const { svc, prisma } = setup();

    await svc.moveAssetSlot(user, 'i1', 'a1', 'BODY_FRONT', 't1');

    expect(prisma.identityAsset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: expect.objectContaining({ captureSlot: 'BODY_FRONT', assetType: 'BODY_IMAGE' }),
    });
  });

  it('영상 자산은 여전히 슬롯을 옮길 수 없다', async () => {
    const { svc } = setup({ ...unsorted, assetType: 'VIDEO' });

    await expect(svc.moveAssetSlot(user, 'i1', 'a1', 'FRONT', 't1')).rejects.toThrow(/이미지 자산만/);
  });

  it('썸네일을 발급한다 — 사진을 못 보면 어떤 슬롯인지 고를 수 없다', async () => {
    const { svc, s3 } = setup();

    const { assets } = await svc.listAssets(user, 'i1');

    expect(s3.presignGet).toHaveBeenCalledWith(unsorted.storageKey);
    expect(assets[0].previewUrl).toBe('https://s3.example/a1');
    expect(assets[0].rejectReason).toBe('UNCLASSIFIED');
  });

  it('업로드가 끝나지 않은 사진에는 썸네일을 발급하지 않는다', async () => {
    const { svc, s3 } = setup({ ...unsorted, checksum: 'pending' });

    const { assets } = await svc.listAssets(user, 'i1');

    expect(assets[0].previewUrl).toBeNull();
    expect(s3.presignGet).not.toHaveBeenCalled();
  });
});
