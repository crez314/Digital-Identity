import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CrezError, ErrorCode, hasPermission, type Permission } from '@crez/shared';
import { PERMISSION_KEY, PUBLIC_KEY } from './roles.decorator';

/** §16 역할별 권한 강제 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;

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
