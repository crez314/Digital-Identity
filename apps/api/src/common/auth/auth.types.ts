import type { Role } from '@crez/shared';

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  role: Role;
}

declare module 'express' {
  interface Request {
    user?: AuthUser;
    traceId?: string;
  }
}
