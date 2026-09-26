import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@crez/shared';
import { assertAuthConfig, isDevAuth } from '../common/auth/auth-mode';
import { AuthService } from '../common/auth/auth.service';
import { RolesGuard } from '../common/auth/roles.guard';
import { PUBLIC_KEY } from '../common/auth/roles.decorator';

const ENV_KEYS = ['AUTH_MODE', 'NODE_ENV', 'OIDC_ISSUER', 'OIDC_AUDIENCE'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function setEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
}

afterEach(() => setEnv(saved as never));

describe('인증 모드 기동 검사 (§16 fail-closed)', () => {
  it('AUTH_MODE가 없거나 틀린 값이면 기동하지 않는다', () => {
    expect(() => assertAuthConfig({})).toThrow(/미설정/);
    expect(() => assertAuthConfig({ AUTH_MODE: '' })).toThrow(/AUTH_MODE/);
    expect(() => assertAuthConfig({ AUTH_MODE: 'DEV' })).toThrow(/AUTH_MODE/);
  });

  it('운영(NODE_ENV=production)에서는 dev 모드를 거부한다', () => {
    expect(assertAuthConfig({ AUTH_MODE: 'dev', NODE_ENV: 'development' })).toBe('dev');
    expect(() => assertAuthConfig({ AUTH_MODE: 'dev', NODE_ENV: 'production' })).toThrow(/production/);
  });

  it('oidc는 발급자와 audience가 모두 있어야 한다', () => {
    expect(() => assertAuthConfig({ AUTH_MODE: 'oidc', OIDC_AUDIENCE: 'crez-api' })).toThrow(/OIDC_ISSUER/);
    expect(() => assertAuthConfig({ AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://id.example.com' })).toThrow(/OIDC_AUDIENCE/);
    expect(assertAuthConfig({ AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://id.example.com', OIDC_AUDIENCE: 'crez-api' })).toBe('oidc');
  });

  it('요청 처리 중 dev 판정은 명시적 dev이면서 운영이 아닐 때만 참이다', () => {
    expect(isDevAuth({ AUTH_MODE: 'dev' })).toBe(true);
    expect(isDevAuth({})).toBe(false);
    expect(isDevAuth({ AUTH_MODE: 'development' })).toBe(false);
    expect(isDevAuth({ AUTH_MODE: 'dev', NODE_ENV: 'production' })).toBe(false);
  });
});

describe('요청 경로의 fail-closed', () => {
  const owner = { id: 'u1', orgId: 'o1', email: 'owner@hicrez.com', role: 'OWNER', status: 'ACTIVE' };

  it('AUTH_MODE가 없으면 x-dev-user 헤더로 로그인되지 않는다', async () => {
    setEnv({ NODE_ENV: 'test' });
    const prisma = { appUser: { findUnique: vi.fn().mockResolvedValue(owner) } };
    const svc = new AuthService(prisma as never);

    await expect(svc.resolve(undefined, 'owner@hicrez.com')).rejects.toMatchObject({ code: ErrorCode.AUTH_UNAUTHENTICATED });
    expect(prisma.appUser.findUnique).not.toHaveBeenCalled();
  });

  it('운영에서 AUTH_MODE=dev가 들어와도 헤더 사칭이 되지 않는다', async () => {
    setEnv({ AUTH_MODE: 'dev', NODE_ENV: 'production' });
    const prisma = { appUser: { findUnique: vi.fn().mockResolvedValue(owner) } };
    const svc = new AuthService(prisma as never);

    await expect(svc.resolve(undefined, 'owner@hicrez.com')).rejects.toMatchObject({ code: ErrorCode.AUTH_UNAUTHENTICATED });
  });

  it('oidc인데 audience가 없으면 토큰을 검증하지 않고 거부한다', async () => {
    setEnv({ AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://id.example.com' });
    const svc = new AuthService({ appUser: { findUnique: vi.fn() } } as never);

    await expect(svc.resolve('Bearer x.y.z', undefined)).rejects.toMatchObject({ code: ErrorCode.INTERNAL });
  });

  it('역할 검사는 명시적 dev·비운영일 때만 건너뛴다', () => {
    const reflector = { getAllAndOverride: vi.fn((key: string) => (key === PUBLIC_KEY ? false : 'IDENTITY_WRITE')) };
    const ctx = {
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({ getRequest: () => ({ user: { role: 'VIEWER' } }) }),
    };
    const guard = new RolesGuard(reflector as never);

    setEnv({ AUTH_MODE: 'dev', NODE_ENV: 'development' });
    expect(guard.canActivate(ctx as never)).toBe(true);

    for (const env of [{ NODE_ENV: 'test' }, { AUTH_MODE: 'dev', NODE_ENV: 'production' }, { AUTH_MODE: 'oidc' }]) {
      setEnv(env);
      expect(() => guard.canActivate(ctx as never)).toThrow(/IDENTITY_WRITE/);
    }
  });
});
