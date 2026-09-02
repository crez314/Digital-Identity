import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@crez/db';
import { logger } from '@crez/shared';
import { PRISMA } from '../prisma.module';

/**
 * §14.2 감사 로그. append-only이며 애플리케이션 경로로 수정·삭제할 수 없다
 * (DB 트리거로도 강제 — packages/db 마이그레이션 참조).
 *
 * 다음 이벤트는 예외 없이 기록한다:
 *  Identity 등록·수정·상태 변경, 자산 업로드·비활성화, 프로파일 빌드·활성화,
 *  권리 정보 변경(전후 값 포함), 생성 요청(사용 Identity·프로파일 버전·모델·운영자·결과물),
 *  QC 실패 세그먼트 수동 승인(사유 필수), 마스터 확정 및 배포.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async record(input: {
    orgId: string;
    actorId?: string | null;
    action: string;
    identityId?: string | null;
    projectId?: string | null;
    payload: Record<string, unknown>;
    traceId?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          orgId: input.orgId,
          actorId: input.actorId ?? null,
          action: input.action,
          identityId: input.identityId ?? null,
          projectId: input.projectId ?? null,
          payload: input.payload as never,
          traceId: input.traceId ?? null,
        },
      });
    } catch (e) {
      // 감사 기록 실패는 조용히 넘기지 않는다. 다만 본 트랜잭션을 되돌리지는 않는다.
      logger.error({ err: String(e), action: input.action, traceId: input.traceId }, 'audit write failed');
    }
  }
}
