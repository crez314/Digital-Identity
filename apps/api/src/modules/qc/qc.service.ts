import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@crez/db';
import { decideStrategy, type PriorAttempt } from '@crez/engine';
import { CrezError, ErrorCode, MAX_REGEN, QUEUE } from '@crez/shared';
import { JOB_NAME, type RegenStrategy } from '@crez/contracts';
import { PRISMA } from '../../common/prisma.module';
import { QueueService } from '../../common/queue/queue.service';
import { AuditService } from '../../common/audit/audit.service';
import { EventsService } from '../../common/events/events.service';
import { S3Service } from '../../common/storage/s3.service';
import type { AuthUser } from '../../common/auth/auth.types';
import { ProjectService } from '../project/project.service';

@Injectable()
export class QcService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly s3: S3Service,
    private readonly projects: ProjectService,
  ) {}

  /** §6.4 GET /segments/{id}/qc-runs — QC 이력 */
  async listRuns(user: AuthUser, segmentId: string) {
    const runs = await this.prisma.qcRun.findMany({
      where: { output: { job: { segment: { id: segmentId, project: { orgId: user.orgId } } } } },
      orderBy: { createdAt: 'desc' },
      include: { findings: true, output: { include: { job: true } } },
    });
    return runs.map((r) => ({
      id: r.id, outputId: r.outputId, attempt: r.output.job.attempt,
      rulesetVersion: r.rulesetVersion, status: r.status,
      overallScore: r.overallScore ? Number(r.overallScore) : null,
      findingCount: r.findings.length,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** §6.4 GET /qc-runs/{id} — 점수·findings·유사도 시계열 */
  async getRun(user: AuthUser, id: string) {
    const run = await this.prisma.qcRun.findFirst({
      where: { id, output: { job: { segment: { project: { orgId: user.orgId } } } } },
      include: {
        findings: { orderBy: { startMs: 'asc' } },
        output: { include: { job: { include: { segment: true, model: true } } } },
      },
    });
    if (!run) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, 'QC run을 찾을 수 없음', { id }, 404);

    // 원시 시계열은 S3에 있고, 뷰어가 직접 받도록 presigned URL을 준다(§15).
    const seriesUrl = run.seriesKey ? (await this.s3.presignGet(run.seriesKey)).url : null;
    const outputUrl = (await this.s3.presignGet(run.output.storageKey)).url;

    return {
      id: run.id,
      segmentId: run.output.job.segmentId,
      attempt: run.output.job.attempt,
      modelCode: run.output.job.model.code,
      rulesetVersion: run.rulesetVersion,
      status: run.status,
      overallScore: run.overallScore ? Number(run.overallScore) : null,
      perIdentity: run.perIdentity as Record<string, unknown> | null,
      modelBundle: run.modelBundle as Record<string, unknown>,
      seriesUrl,
      outputUrl,
      createdAt: run.createdAt.toISOString(),
      findings: run.findings.map((f) => ({
        id: f.id, identityId: f.identityId, findingType: f.findingType, severity: f.severity,
        startMs: f.startMs, endMs: f.endMs, confidence: Number(f.confidence),
        evidence: f.evidence as Record<string, unknown>,
      })),
    };
  }

  /**
   * §6.4 POST /segments/{id}/regenerate — 수동 재생성. 전략 override 가능.
   * override가 없으면 전략 사다리(§11)가 다음 단계를 결정한다.
   */
  async regenerate(
    user: AuthUser, segmentId: string,
    input: { strategyOverride?: Partial<RegenStrategy>; reason?: string },
    traceId: string,
  ) {
    const segment = await this.prisma.segment.findFirst({
      where: { id: segmentId, project: { orgId: user.orgId } },
      include: {
        project: true,
        regenTasks: { orderBy: { createdAt: 'asc' } },
        jobs: {
          orderBy: { attempt: 'desc' }, take: 1,
          include: { outputs: { include: { qcRuns: { orderBy: { createdAt: 'desc' }, take: 1, include: { findings: true } } } } },
        },
      },
    });
    if (!segment) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '세그먼트를 찾을 수 없음', { segmentId }, 404);
    if (segment.status === 'GENERATING' || segment.status === 'QC') {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, `${segment.status} 중에는 재생성을 요청할 수 없습니다`, null, 409);
    }

    const lastJob = segment.jobs[0];
    const lastQc = lastJob?.outputs[0]?.qcRuns[0];
    if (!lastQc) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, 'QC 결과가 없는 세그먼트는 재생성 전략을 결정할 수 없습니다', null, 409);
    }

    const priorAttempts: PriorAttempt[] = segment.regenTasks.map((t) => ({
      strategy: t.strategy as unknown as PriorAttempt['strategy'],
      outcome: t.outcome as PriorAttempt['outcome'],
      scoreAfter: t.scoreAfter ? Number(t.scoreAfter) : null,
    }));

    const perIdentity = (lastQc.perIdentity ?? {}) as Record<string, { score?: number }>;
    const failing = Object.entries(perIdentity).filter(([, v]) => (v.score ?? 1) < 0.85).map(([k]) => k);

    const decision = decideStrategy({
      findings: lastQc.findings.map((f) => ({
        identityId: f.identityId, findingType: f.findingType as never,
        severity: f.severity as never, startMs: f.startMs, endMs: f.endMs,
        confidence: Number(f.confidence), evidence: {},
      })),
      priorAttempts,
      attemptCount: segment.attemptCount,
      segmentDurationMs: segment.endMs - segment.startMs,
      lastModelId: lastJob?.modelId ?? null,
      lastConditioningStrength: Number((lastJob?.params as { conditioningStrength?: number })?.conditioningStrength ?? 0.6),
      failingIdentityIds: failing,
    });

    // 운영자 override는 사다리 판단보다 우선한다. 다만 이력에 override 사실을 남긴다.
    const strategy: RegenStrategy = input.strategyOverride
      ? {
          step: input.strategyOverride.step ?? decision.strategy.step,
          kind: (input.strategyOverride.kind ?? decision.strategy.kind) as RegenStrategy['kind'],
          params: { ...decision.strategy.params, ...(input.strategyOverride.params ?? {}) },
          rationale: `운영자 override: ${input.reason ?? '사유 미기재'} (자동 판단: ${decision.strategy.rationale})`,
        }
      : decision.strategy;

    if (!input.strategyOverride && decision.escalate) {
      await this.prisma.$transaction([
        this.prisma.segment.update({ where: { id: segmentId }, data: { status: 'MANUAL_REVIEW' } }),
        this.prisma.regenerationTask.create({
          data: {
            segmentId, sourceQcRunId: lastQc.id, strategy: strategy as never,
            outcome: 'ESCALATED', scoreBefore: lastQc.overallScore,
          },
        }),
      ]);
      throw new CrezError(ErrorCode.QC_REGEN_LIMIT, decision.strategy.rationale, { maxRegen: MAX_REGEN }, 409);
    }

    const task = await this.prisma.regenerationTask.create({
      data: {
        segmentId, sourceQcRunId: lastQc.id, strategy: strategy as never,
        scoreBefore: lastQc.overallScore,
      },
    });

    await this.prisma.segment.update({ where: { id: segmentId }, data: { status: 'GENERATING' } });

    const jobId = await this.queue.add(QUEUE.REGENERATION, JOB_NAME.REGENERATION_PLAN, {
      traceId, orgId: user.orgId, projectId: segment.projectId, segmentId,
      qcRunId: lastQc.id, regenerationTaskId: task.id,
    });

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'PROJECT_GENERATED',
      projectId: segment.projectId,
      payload: { event: 'MANUAL_REGENERATE', segmentId, strategy, reason: input.reason ?? null }, traceId,
    });

    return { jobId, taskId: task.id, strategy, traceId };
  }

  /**
   * §6.4 POST /segments/{id}/accept — QC 실패 세그먼트를 운영자 판단으로 승인.
   * 사유 필수이며 별도 감사 대상 행위다(§14.2, §16).
   */
  async accept(user: AuthUser, segmentId: string, input: { reason: string; outputId?: string }, traceId: string) {
    const segment = await this.prisma.segment.findFirst({
      where: { id: segmentId, project: { orgId: user.orgId } },
      include: {
        jobs: { orderBy: { attempt: 'desc' }, include: { outputs: { include: { qcRuns: { orderBy: { createdAt: 'desc' }, take: 1 } } } } },
      },
    });
    if (!segment) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '세그먼트를 찾을 수 없음', { segmentId }, 404);

    const candidates = segment.jobs.flatMap((j) => j.outputs);
    if (candidates.length === 0) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '승인할 결과물이 없습니다', null, 409);
    }
    const outputId = input.outputId ?? candidates[0].id;
    if (!candidates.some((o) => o.id === outputId)) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '이 세그먼트의 결과물이 아닙니다', { outputId }, 422);
    }
    const qcScore = candidates.find((o) => o.id === outputId)?.qcRuns[0]?.overallScore ?? null;

    await this.prisma.segment.update({
      where: { id: segmentId },
      data: { status: 'PASSED', acceptedOutputId: outputId, acceptReason: input.reason, acceptedBy: user.id },
    });

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'QC_MANUAL_ACCEPT',
      projectId: segment.projectId,
      payload: { segmentId, outputId, reason: input.reason, qcScore: qcScore ? Number(qcScore) : null }, traceId,
    });

    await this.events.publish({
      type: 'SEGMENT_STATUS', projectId: segment.projectId, segmentId,
      payload: { status: 'PASSED', manuallyAccepted: true }, at: new Date().toISOString(), traceId,
    });

    // 수동 승인으로 마지막 블로커가 해소되면 프로젝트도 REVIEW로 올라가야 한다 (§5.2).
    await this.projects.refreshProjectStatus(segment.projectId);

    return { segmentId, status: 'PASSED', outputId };
  }
}
