import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CrezError, ErrorCode, hasPermission, type Permission } from '@crez/shared';
import { isDevAuth } from './auth-mode';
import { PERMISSION_KEY, PUBLIC_KEY } from './roles.decorator';

/** §16 역할별 권한 강제 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;

    // 로컬 개발(AUTH_MODE=dev)에서는 접속한 누구나 모든 기능을 쓸 수 있게 역할 검사를 건너뛴다.
    // 'dev'를 명시했고 운영이 아닐 때만 적용한다(auth-mode.ts). 권리 게이트(§14.1)는 권한이 아니므로 그대로 동작한다.
    if (isDevAuth()) return true;

    const required = this.reflector.getAllAndOverride<Permission>(PERMISSION_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const role = req.user?.role;
    if (!role || !hasPermission(role, required)) {
      throw new CrezError(ErrorCode.AUTH_FORBIDDEN, `${required} 권한이 필요합니다 (현재 역할 ${role ?? 'none'})`, null, 403);
    }
    return true;
  }
}
