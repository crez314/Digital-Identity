import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { PrismaClient } from '@crez/db';
import { CrezError, ErrorCode, type Role } from '@crez/shared';
import { PRISMA } from '../prisma.module';
import { isDevAuth } from './auth-mode';
import type { AuthUser } from './auth.types';

/**
 * §1.1 인증: OIDC(Auth0/Keycloak) + JWT.
 * AUTH_MODE=dev이면 로컬 개발을 위해 이메일 헤더로 사용자를 확정한다. 운영(NODE_ENV=production)에서는 켜지지 않고,
 * AUTH_MODE가 없거나 틀린 값이면 dev가 아니라 OIDC로 처리한다(fail-closed, auth-mode.ts).
 * Phase 1은 단일 조직, Phase 6에서 멀티테넌시로 확장한다.
 */
@Injectable()
export class AuthService {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async resolve(authorization: string | undefined, devEmail: string | undefined): Promise<AuthUser> {
    if (isDevAuth()) {
      const email = devEmail ?? process.env.DEV_USER_EMAIL ?? 'owner@hicrez.com';
      const user = await this.prisma.appUser.findUnique({ where: { email } });
      if (!user || user.status !== 'ACTIVE') {
        throw new CrezError(ErrorCode.AUTH_UNAUTHENTICATED, `dev 사용자를 찾을 수 없음: ${email}`, null, 401);
      }
      return { id: user.id, orgId: user.orgId, email: user.email, role: user.role as Role };
    }

    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) throw new CrezError(ErrorCode.AUTH_UNAUTHENTICATED, undefined, null, 401);

    const issuer = process.env.OIDC_ISSUER;
    const audience = process.env.OIDC_AUDIENCE;
    // audience 없이 검증하면 같은 발급자가 다른 서비스용으로 발급한 토큰도 통과한다
    if (!issuer || !audience) throw new CrezError(ErrorCode.INTERNAL, 'OIDC_ISSUER·OIDC_AUDIENCE 미설정', null, 500);
    this.jwks ??= createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/.well-known/jwks.json`));

    try {
      const { payload } = await jwtVerify(token, this.jwks, { issuer, audience });
      const email = String(payload.email ?? '');
      const user = await this.prisma.appUser.findUnique({ where: { email } });
      if (!user || user.status !== 'ACTIVE') {
        throw new CrezError(ErrorCode.AUTH_UNAUTHENTICATED, '등록되지 않은 사용자', { email }, 401);
      }
      return { id: user.id, orgId: user.orgId, email: user.email, role: user.role as Role };
    } catch (e) {
      if (e instanceof CrezError) throw e;
      throw new CrezError(ErrorCode.AUTH_UNAUTHENTICATED, 'JWT 검증 실패', String(e), 401);
    }
  }
}
