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
      // 어떤 상태라서 빠졌는지 알려준다 — "없습니다"만으로는 무엇을 해야 할지 알 수 없다
      const byStatus = await this.prisma.segment.groupBy({ by: ['status'], where: { projectId }, _count: true });
      const summary = byStatus.map((g) => `${g.status} ${g._count}개`).join(', ') || '정의된 구간 없음';
      throw new CrezError(
        ErrorCode.PRJ_INVALID_STATE,
        `생성 대기(PENDING)·실패(FAILED) 구간이 없습니다 — 현재 ${summary}. `
        + 'MANUAL_REVIEW 구간은 QC 화면에서 재생성을 요청하거나 승인하고, 되돌리려면 구간 초기화를 쓰세요.',
        { statuses: Object.fromEntries(byStatus.map((g) => [g.status, g._count])) },
        409,
      );
    }

    const submitted: Array<{ segmentId: string; jobId: string; attempt: number }> = [];
    for (const seg of segments) {
      if (seg.status === 'GENERATING' || seg.status === 'QC') continue;
      if (seg.attemptCount >= MAX_GENERATION_ATTEMPT) {
        // 한도를 넘긴 세그먼트는 자동 실행 대상이 아니다 — 수동 재생성 경로로만 처리한다.
        continue;
      }
      // 기록상 시도 번호는 job 이력에서 이어 붙인다. generation_job은 (segment_id, attempt)가 유일하므로,
      // 구간 초기화로 attemptCount가 0으로 돌아간 뒤 1부터 다시 쓰면 저장이 실패해 구간이 GENERATING에 멈춘다.
      // 한도 판정은 segment.attemptCount(초기화 가능)로, 기록·스토리지 경로는 job attempt로 나눈다.
      const last = await this.prisma.generationJob.aggregate({ _max: { attempt: true }, where: { segmentId: seg.id } });
      const attempt = Math.max(last._max.attempt ?? 0, seg.attemptCount) + 1;
      await this.prisma.segment.update({
        where: { id: seg.id }, data: { status: 'GENERATING', attemptCount: seg.attemptCount + 1 },
      });
      const jobId = await this.queue.add(
        QUEUE.GENERATION, JOB_NAME.GENERATION_SUBMIT,
        { traceId, orgId: user.orgId, projectId, segmentId: seg.id, attempt, modelHint: input.modelHint },
        { priority: input.priority ?? 5 },
      );
      submitted.push({ segmentId: seg.id, jobId, attempt });
    }

    // 고른 구간이 전부 걸러졌으면 조용히 빈 결과를 돌려주지 않는다 — 눌렀는데 아무 일도 없는 것처럼 보인다
    if (submitted.length === 0) {
      const exhausted = segments.filter((s) => s.attemptCount >= MAX_GENERATION_ATTEMPT).length;
      throw new CrezError(
        ErrorCode.PRJ_INVALID_STATE,
        exhausted > 0
          ? `구간 ${exhausted}개가 시도 한도 ${MAX_GENERATION_ATTEMPT}회를 모두 썼습니다 — 원인을 고친 뒤 구간 초기화로 되돌리거나 QC 화면에서 재생성을 요청하세요`
          : '생성·QC가 진행 중이라 새로 제출할 구간이 없습니다',
        { exhausted, selected: segments.length },
        409,
      );
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

    // 제공자에 이미 제출된 작업은 로컬 상태만 바꾼다고 멈추지 않는다 — 계속 생성되고 과금된다(§12.1).
    // 취소 요청은 외부 API 호출이라 워커가 한다(§2.2).
    const inFlight = await this.prisma.generationJob.findMany({
      where: {
        status: { in: ['QUEUED', 'SUBMITTED', 'RUNNING'] },
        segment: { projectId },
        providerJobId: { not: null },
      },
      select: { id: true, segmentId: true, providerJobId: true },
    });

    const removed = await this.queue.cancelByProject(projectId);
    const { count } = await this.prisma.generationJob.updateMany({
      where: { status: { in: ['QUEUED', 'SUBMITTED', 'RUNNING'] }, segment: { projectId } },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });

    // 큐를 비운 뒤에 넣어야 방금 넣은 취소 작업이 함께 지워지지 않는다
    for (const job of inFlight) {
      await this.queue.add(
        QUEUE.GENERATION, JOB_NAME.GENERATION_CANCEL,
        {
          traceId, orgId: user.orgId, projectId, segmentId: job.segmentId,
          generationJobId: job.id, providerJobId: job.providerJobId,
        },
        { priority: 1 },
      );
    }
    await this.prisma.segment.updateMany({
      where: { projectId, status: 'GENERATING' }, data: { status: 'PENDING' },
    });

    // 결과를 하나도 만들지 않은 채 취소했으면 생성 전(READY)으로 되돌린다.
    // RUNNING에 남으면 생성 설정·캐스팅·구간을 고칠 수 없어 프로젝트가 갇힌다.
    const reverted = await this.revertToReadyIfNothingGenerated(projectId, project.status);

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'PROJECT_GENERATED', projectId,
      payload: {
        event: 'CANCELLED', removedQueueJobs: removed, cancelledJobs: count,
        providerCancelRequested: inFlight.length, revertedToReady: reverted,
      },
      traceId,
    });
    await this.events.publish({
      type: 'PROJECT_STATUS', projectId, payload: { status: 'CANCELLED', cancelledJobs: count },
      at: new Date().toISOString(), traceId,
    });
    // providerCancelRequested는 "요청했다"는 뜻이다 — 제공자가 거부하면 그 생성은 끝까지 가고 과금된다
    return {
      removedQueueJobs: removed, cancelledJobs: count,
      providerCancelRequested: inFlight.length, revertedToReady: reverted,
    };
  }

  private async revertToReadyIfNothingGenerated(projectId: string, status: string): Promise<boolean> {
    if (status !== 'RUNNING') return false;
    const [inFlight, produced] = await Promise.all([
      this.prisma.segment.count({ where: { projectId, status: { in: ['GENERATING', 'QC'] } } }),
      this.prisma.generationJob.count({ where: { segment: { projectId }, status: { notIn: ['CANCELLED', 'FAILED'] } } }),
    ]);
    if (inFlight > 0 || produced > 0) return false;
    await this.prisma.project.update({ where: { id: projectId }, data: { status: 'READY' } });
    return true;
  }
}
