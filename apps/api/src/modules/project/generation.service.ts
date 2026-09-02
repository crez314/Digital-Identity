import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@crez/db';
import { CrezError, ErrorCode, MAX_GENERATION_ATTEMPT, QUEUE } from '@crez/shared';
import { JOB_NAME } from '@crez/contracts';
import { PRISMA } from '../../common/prisma.module';
import { QueueService } from '../../common/queue/queue.service';
import { AuditService } from '../../common/audit/audit.service';
import { EventsService } from '../../common/events/events.service';
import { RightsService } from '../rights/rights.service';
import type { AuthUser } from '../../common/auth/auth.types';

/**
 * §6.3 POST /projects/{id}/generate — 생성 실행.
 * crez-api는 큐 제출까지만 담당한다. 모델 라우팅·제출·폴링은 워커가 한다(§2.2).
 */
@Injectable()
export class GenerationService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly rights: RightsService,
  ) {}

  async generate(
    user: AuthUser, projectId: string,
    input: { segmentIds?: string[]; modelHint?: string; priority?: number },
    traceId: string,
  ) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, orgId: user.orgId },
      include: { cast: { include: { identity: true } } },
    });
    if (!project) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, undefined, { projectId }, 404);
    if (!['READY', 'RUNNING', 'REVIEW'].includes(project.status)) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, `${project.status} 상태에서는 생성할 수 없습니다. 캐스팅·매핑·씬 정의를 완료하세요.`, null, 409);
    }
    if (project.cast.length === 0) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '캐스트가 비어 있습니다', null, 409);
    }

    // 게이트 2 — 캐스팅 이후 권리가 만료·철회되었을 수 있으므로 제출 직전 재검사 (§14.1)
    const config = project.config as { usageType?: string; territory?: string };
    await this.rights.enforce(
      user,
      {
        identityIds: project.cast.map((c) => c.identityId),
        usageType: config.usageType ?? project.projectType,
        territory: config.territory,
      },
      'GENERATION',
      traceId,
    );

    const segments = await this.prisma.segment.findMany({
      where: {
        projectId,
        ...(input.segmentIds?.length ? { id: { in: input.segmentIds } } : { status: { in: ['PENDING', 'FAILED'] } }),
      },
      orderBy: { segmentIndex: 'asc' },
    });
    if (segments.length === 0) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '생성할 세그먼트가 없습니다', null, 409);
    }

    const submitted: Array<{ segmentId: string; jobId: string; attempt: number }> = [];
    for (const seg of segments) {
      if (seg.status === 'GENERATING' || seg.status === 'QC') continue;
      if (seg.attemptCount >= MAX_GENERATION_ATTEMPT) {
        // 한도를 넘긴 세그먼트는 자동 실행 대상이 아니다 — 수동 재생성 경로로만 처리한다.
        continue;
      }
      const attempt = seg.attemptCount + 1;
      await this.prisma.segment.update({
        where: { id: seg.id }, data: { status: 'GENERATING', attemptCount: attempt },
      });
      const jobId = await this.queue.add(
        QUEUE.GENERATION, JOB_NAME.GENERATION_SUBMIT,
        { traceId, orgId: user.orgId, projectId, segmentId: seg.id, attempt, modelHint: input.modelHint },
        { priority: input.priority ?? 5 },
      );
      submitted.push({ segmentId: seg.id, jobId, attempt });
    }

    if (project.status !== 'RUNNING') {
      await this.prisma.project.update({ where: { id: projectId }, data: { status: 'RUNNING' } });
    }

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'PROJECT_GENERATED', projectId,
      payload: {
        segmentCount: submitted.length,
        modelHint: input.modelHint ?? null,
        cast: project.cast.map((c) => ({ identityId: c.identityId, profileId: c.profileId, code: c.identity.code })),
      },
      traceId,
    });

    await this.events.publish({
      type: 'PROJECT_STATUS', projectId,
      payload: { status: 'RUNNING', submitted: submitted.length },
      at: new Date().toISOString(), traceId,
    });

    return { submitted, traceId };
  }

  /** §6.3 POST /projects/{id}/cancel */
  async cancel(user: AuthUser, projectId: string, traceId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, orgId: user.orgId } });
    if (!project) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, undefined, { projectId }, 404);

    const removed = await this.queue.cancelByProject(projectId);
    const { count } = await this.prisma.generationJob.updateMany({
      where: { status: { in: ['QUEUED', 'SUBMITTED', 'RUNNING'] }, segment: { projectId } },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    await this.prisma.segment.updateMany({
      where: { projectId, status: 'GENERATING' }, data: { status: 'PENDING' },
    });

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'PROJECT_GENERATED', projectId,
      payload: { event: 'CANCELLED', removedQueueJobs: removed, cancelledJobs: count }, traceId,
    });
    await this.events.publish({
      type: 'PROJECT_STATUS', projectId, payload: { status: 'CANCELLED', cancelledJobs: count },
      at: new Date().toISOString(), traceId,
    });
    return { removedQueueJobs: removed, cancelledJobs: count };
  }
}
