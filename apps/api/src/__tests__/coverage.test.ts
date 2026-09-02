import { describe, expect, it } from 'vitest';
import { REQUIRED_BODY_SLOTS, REQUIRED_FACE_SLOTS, hasPermission } from '@crez/shared';
import { IdentityService } from '../modules/identity/identity.service';

// coverage는 의존성을 쓰지 않는 순수 계산이므로 서비스 인스턴스를 직접 만든다.
const svc = new IdentityService(null as never, null as never, null as never, null as never);

describe('캡처 슬롯 충족률 (§6.1, CREZ-IDN-001)', () => {
  it('필수 슬롯이 모두 있으면 빌드 가능', () => {
    const c = svc.coverage([...REQUIRED_FACE_SLOTS, ...REQUIRED_BODY_SLOTS]);
    expect(c.buildable).toBe(true);
    expect(c.missingSlots).toHaveLength(0);
    expect(c.coverageRatio).toBe(1);
  });

  it('하나라도 빠지면 빌드 불가이며 어떤 슬롯인지 알려준다', () => {
    const c = svc.coverage([...REQUIRED_FACE_SLOTS]);
    expect(c.buildable).toBe(false);
    expect(c.missingSlots).toEqual([...REQUIRED_BODY_SLOTS]);
  });

  it('필수가 아닌 슬롯은 충족률을 올리지 않는다', () => {
    const c = svc.coverage(['UP', 'DOWN', 'FRONT']);
    expect(c.buildable).toBe(false);
    expect(c.coverageRatio).toBeLessThan(1);
  });

  it('null 슬롯(미지정 자산)은 무시한다', () => {
    const c = svc.coverage([null, null, 'FRONT']);
    expect(c.filledSlots).toEqual(['FRONT']);
  });
});

describe('역할별 권한 (§16)', () => {
  it('OPERATOR는 실행은 하되 QC 승인은 못 한다', () => {
    expect(hasPermission('OPERATOR', 'PROJECT_RUN')).toBe(true);
    expect(hasPermission('OPERATOR', 'QC_ACCEPT')).toBe(false);
  });

  it('PRODUCER는 QC 승인이 가능하지만 권리 정보는 못 고친다', () => {
    expect(hasPermission('PRODUCER', 'QC_ACCEPT')).toBe(true);
    expect(hasPermission('PRODUCER', 'RIGHTS_WRITE')).toBe(false);
  });

  it('VIEWER는 조회만 가능하다', () => {
    expect(hasPermission('VIEWER', 'READ')).toBe(true);
    for (const p of ['IDENTITY_WRITE', 'PROJECT_RUN', 'QC_ACCEPT', 'RIGHTS_WRITE'] as const) {
      expect(hasPermission('VIEWER', p)).toBe(false);
    }
  });

  it('알 수 없는 역할은 아무 권한도 갖지 않는다', () => {
    expect(hasPermission('GUEST', 'READ')).toBe(false);
  });
});
