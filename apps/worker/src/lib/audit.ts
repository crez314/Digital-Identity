import { prisma } from '@crez/db';
import { logger } from '@crez/shared';

/** §14.2 워커에서 발생하는 감사 이벤트 기록 */
export async function audit(input: {
  orgId: string;
  action: string;
  actorId?: string | null;
  identityId?: string | null;
  projectId?: string | null;
  payload: Record<string, unknown>;
  traceId?: string | null;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        orgId: input.orgId, actorId: input.actorId ?? null, action: input.action,
        identityId: input.identityId ?? null, projectId: input.projectId ?? null,
        payload: input.payload as never, traceId: input.traceId ?? null,
      },
    });
  } catch (e) {
    logger.error({ err: String(e), action: input.action }, 'worker audit write failed');
  }
}
