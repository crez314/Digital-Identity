import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@crez/shared';

export const PERMISSION_KEY = 'crez:permission';
export const PUBLIC_KEY = 'crez:public';

/** §16 역할별 권한 — 컨트롤러 핸들러에 필요한 권한을 선언한다. */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);
export const Public = () => SetMetadata(PUBLIC_KEY, true);
