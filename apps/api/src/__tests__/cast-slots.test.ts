import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@crez/shared';
import { ProjectService } from '../modules/project/project.service';

const user = { id: 'u1', orgId: 'org1' } as never;
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function setup() {
  const prisma = { project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1', orgId: 'org1', status: 'DRAFT' }) } };
  const rights = { enforce: vi.fn().mockRejectedValue(new Error('rights reached')) };
  const svc = new ProjectService(prisma as never, null as never, null as never, null as never, null as never, rights as never);
  return { svc, rights };
}

describe('캐스팅 위치 (slotIndex)', () => {
  it('같은 인물을 두 위치에 넣으면 권리 검사 전에 거절한다', async () => {
    const { svc, rights } = setup();
    await expect(svc.setCast(user, 'p1', {
      usageType: 'MV', cast: [{ identityId: A, slotIndex: 0, appearance: {} }, { identityId: A, slotIndex: 1, appearance: {} }],
    }, 't1')).rejects.toMatchObject({ code: ErrorCode.PRJ_INVALID_STATE, httpStatus: 422 });
    expect(rights.enforce).not.toHaveBeenCalled();
  });

  it('위치가 겹치거나 1번부터 이어지지 않으면 거절한다', async () => {
    for (const slots of [[0, 0], [1, 2], [0, 2]]) {
      const { svc, rights } = setup();
      await expect(svc.setCast(user, 'p1', {
        usageType: 'MV', cast: [{ identityId: A, slotIndex: slots[0], appearance: {} }, { identityId: B, slotIndex: slots[1], appearance: {} }],
      }, 't1')).rejects.toMatchObject({ code: ErrorCode.PRJ_INVALID_STATE });
      expect(rights.enforce).not.toHaveBeenCalled();
    }
  });

  it('입력 순서와 무관하게 0번부터 이어지면 권리 검사로 넘어간다', async () => {
    const { svc, rights } = setup();
    await expect(svc.setCast(user, 'p1', {
      usageType: 'MV', cast: [{ identityId: B, slotIndex: 1, appearance: {} }, { identityId: A, slotIndex: 0, appearance: {} }],
    }, 't1')).rejects.toThrow('rights reached');
    expect(rights.enforce).toHaveBeenCalledOnce();
  });
});
