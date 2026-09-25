import { Inject, Injectable } from '@nestjs/common';
import { generationDispatchId, lockOrganizationSpend, nextGenerationAttempt, reserveSpend, type Prisma, type PrismaClient } from '@crez/db';
import { COST_CONFIRM_THRESHOLD, childLogger, CrezError, ErrorCode, MAX_GENERATION_ATTEMPT, QUEUE } from '@crez/shared';
import { estimateRun } from '@crez/engine';
import { JOB_NAME } from '@crez/contracts';
import { PRISMA } from '../../common/prisma.module';
import { QueueService } from '../../common/queue/queue.service';
import { AuditService } from '../../common/audit/audit.service';
import { EventsService } from '../../common/events/events.service';
import { RightsService } from '../rights/rights.service';
import { SpendService } from '../spend/spend.service';
import type { AuthUser } from '../../common/auth/auth.types';

/**
 * §6.3 POST /projects/{id}/generate — 생성 실행.
 * crez-api는 큐 제출까지만 담당한다. 모델 라우팅·제출·폴링은 워커가 한다(§2.2).
 */
/** 확인 없이 진행할 수 있는 상한. 운영 중 조정할 수 있게 환경변수를 먼저 본다 */
function costConfirmThreshold(): number {
  const v = Number(process.env.GENERATION_COST_CONFIRM_THRESHOLD);
  return Number.isFinite(v) && v >= 0 ? v : COST_CONFIRM_THRESHOLD;
}

/**
 * 모델의 초당 단가. 소리를 켜면 카탈로그가 공시한 상한 단가(costPerSecondAudio)를 쓴다 —
 * 모르면 기본 단가를 그대로 쓰되, 아는 경우에는 높은 쪽으로 잡아 한도가 모자라게 계산되지 않게 한다.
 */
function ratePerSecond(model: { costPerSecond: unknown; capabilities: unknown }, audio: boolean): number {
  const base = Number(model.costPerSecond ?? 0);
  if (!audio) return base;
  const withAudio = (model.capabilities as { costPerSecondAudio?: number } | null)?.costPerSecondAudio;
  return typeof withAudio === 'number' && withAudio > base ? withAudio : base;
}

@Injectable()
export class GenerationService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly rights: RightsService,
    private readonly spend: SpendService,
  ) {}

  /**
   * §6.3 POST /projects/{id}/generate/estimate — 제출 없이 비용만 계산한다.
   * 4분짜리는 구간 48개라 실행 한 번이 수십 건의 유료 생성이다. 누르기 전에 볼 수 있어야 한다.
   */
  async estimate(user: AuthUser, projectId: string, input: { segmentIds?: string[]; modelHint?: string }) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, orgId: user.orgId } });
    if (!project) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, undefined, { projectId }, 404);
    const segments = (await this.selectSegments(projectId, input.segmentIds)).filter(
      (s) => !['GENERATING', 'QC'].includes(s.status) && s.attemptCount < MAX_GENERATION_ATTEMPT,
    );
    const cost = await this.estimateCost(project, segments, input.modelHint);
    // 화면이 "이번 실행 얼마 / 이번 달 남은 한도 얼마"를 함께 보여줄 수 있어야 한다
    const spend = await this.spend.status(user);
    return { ...cost, spend };
  }

  async generate(
    user: AuthUser, projectId: string,
    input: { segmentIds?: string[]; modelHint?: string; priority?: number; maxCost?: number },
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

    // 읽기 → 한도 검사 → 예약 → 구간 상태 변경을 조직 잠금 안에서 함께 확정한다.
    // 다른 API 인스턴스도 같은 잠금을 쓰므로 워커가 시작하기 전 연속 요청도 이 예약을 본다.
    const cap = input.maxCost ?? costConfirmThreshold();
    const { planned, cost, budget } = await this.prisma.$transaction(async (tx) => {
      await lockOrganizationSpend(tx, user.orgId);
      const currentProject = await tx.project.findFirst({ where: { id: projectId, orgId: user.orgId } });
      if (!currentProject || !['READY', 'RUNNING', 'REVIEW'].includes(currentProject.status)) {
        throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '프로젝트 상태가 바뀌었습니다. 다시 확인하세요', null, 409);
      }
      const segments = await this.selectSegments(projectId, input.segmentIds, tx);
      const willSubmit = segments.filter(
        (s) => !['GENERATING', 'QC'].includes(s.status) && s.attemptCount < MAX_GENERATION_ATTEMPT,
      );
      if (!willSubmit.length) {
        throw new CrezError(ErrorCode.PRJ_INVALID_STATE,
          '생성할 구간이 없습니다. 진행 상태와 시도 한도를 확인하거나 실패 구간을 초기화하세요', null, 409);
      }
      const cost = await this.estimateCost(currentProject, willSubmit, input.modelHint, tx);
      if (cost.max > cap) {
        throw new CrezError(ErrorCode.PRJ_INVALID_STATE,
          `견적 ${cost.max}이 상한 ${cap}을 넘습니다 — 견적을 다시 확인한 뒤 maxCost로 상한을 지정하세요`,
          { estimate: cost, cap }, 409);
      }
      const planned = [];
      for (const seg of willSubmit) {
        const attempt = await nextGenerationAttempt(tx, seg.id, seg.attemptCount);
        const payload = {
          traceId, orgId: user.orgId, projectId, segmentId: seg.id, attempt,
          ...(input.modelHint ? { modelHint: input.modelHint } : {}),
        };
        planned.push({
          projectId, segmentId: seg.id, attempt,
          amountCredits: cost.perSegment.find((c) => c.segmentId === seg.id)!.max,
          dispatch: { payload, priority: input.priority ?? 5 },
        });
        await tx.segment.update({ where: { id: seg.id },
          data: { status: 'GENERATING', attemptCount: seg.attemptCount + 1 } });
      }
      const budget = await reserveSpend(tx, user.orgId, planned);
      await tx.project.update({ where: { id: projectId }, data: { status: 'RUNNING' } });
      return { planned, cost, budget: cost.free ? null : budget };
    }, { maxWait: 10000, timeout: 20000 });

    const submitted = [];
    for (const entry of planned) {
      const jobId = generationDispatchId(entry.segmentId, entry.attempt);
      try {
        await this.queue.add(QUEUE.GENERATION, JOB_NAME.GENERATION_SUBMIT, entry.dispatch.payload,
          { jobId, priority: entry.dispatch.priority, removeOnComplete: false, removeOnFail: false });
        await this.prisma.spendEntry.update({
          where: { segmentId_attempt: { segmentId: entry.segmentId, attempt: entry.attempt } },
          data: { dispatchedAt: new Date() },
        });
      } catch (error) {
        // 요청은 DB에 확정됐다. 큐 ACK 유실도 같은 jobId로 재전달하므로 중복 과금하지 않는다.
        childLogger({ traceId }).warn({ err: String(error), jobId }, '생성 큐 인계를 복구 대상으로 남긴다');
      }
      submitted.push({ segmentId: entry.segmentId, jobId, attempt: entry.attempt });
    }

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'PROJECT_GENERATED', projectId,
      payload: {
        segmentCount: submitted.length,
        estimatedCost: { min: cost.min, max: cost.max, worstCase: cost.worstCase, models: cost.models },
        costCap: cap,
        budget: budget && {
          monthToDateKrw: budget.monthToDateKrw, estimateKrw: budget.estimateKrw,
          remainingKrw: budget.remainingKrw,
        },
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

    return { submitted, estimatedCost: cost, budget, traceId };
  }

  /** 자동 선택(PENDING·FAILED)과 지정 선택을 한 곳에서 처리한다 — 견적과 실행이 같은 집합을 봐야 한다 */
  private selectSegments(projectId: string, segmentIds?: string[], db: Prisma.TransactionClient = this.prisma) {
    return db.segment.findMany({
      where: {
        projectId,
        ...(segmentIds?.length ? { id: { in: segmentIds } } : { status: { in: ['PENDING', 'FAILED'] } }),
      },
      orderBy: { segmentIndex: 'asc' },
    });
  }

  /**
   * 구간 길이 × 모델 초당 단가. 모델이 고정돼 있지 않으면 라우터가 무엇을 고를지 알 수 없으므로
   * 후보 단가의 최소·최대 구간으로 답한다.
   *
   * 견적과 실제 제출이 같은 후보 집합을 봐야 상한이 제 역할을 한다. 없는 모델을 modelHint로 주면
   * 견적은 0인데 워커는 다른 유료 모델을 골라 제출하던 우회 경로가 있었다 —
   * 그래서 쓸 수 없는 지정 모델은 여기서 거절한다.
   */
  private async estimateCost(
    project: { config: unknown },
    segments: Array<{ id: string; segmentIndex: number; startMs: number; endMs: number }>,
    modelHint?: string,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const config = project.config as { preferredModel?: string; requiredMode?: string };
    const pinned = modelHint ?? config.preferredModel;

    const models = await db.aiModel.findMany({
      where: { status: 'ACTIVE', ...(pinned ? { code: pinned } : {}) },
      select: { code: true, costPerSecond: true, capabilities: true },
    });
    // 모드가 맞지 않는 모델은 라우터가 고를 수 없으므로 견적에서도 뺀다.
    // 라우터는 길이·인원·해상도까지 더 걸러내므로 여기 후보는 실제 후보를 포함하는 더 넓은 집합이다 —
    // 상한 판정에 쓰는 max는 그만큼 보수적이 된다.
    const mode = config.requiredMode;
    // 소리를 켜면 초당 단가가 오르는 모델이 있다 — 견적도 그 단가로 잡아야 한도가 제 역할을 한다.
    const audio = (config as { audio?: boolean }).audio !== false;
    const candidates = models.filter((m) => {
      if (!mode) return true;
      const modes = (m.capabilities as { modes?: string[] } | null)?.modes;
      return !modes || modes.includes(mode);
    });

    if (candidates.length === 0) {
      throw new CrezError(
        ErrorCode.GEN_NO_CAPABLE_MODEL,
        pinned
          ? `지정 모델 ${pinned}을(를) 쓸 수 없습니다 — 등록되어 있고 ACTIVE이며 ${mode ?? '이 방식'}을 지원하는지 확인하세요`
          : `${mode ?? '이 방식'}을 지원하는 활성 모델이 없습니다`,
        { pinnedModel: pinned ?? null, requiredMode: mode ?? null },
        422,
      );
    }

    const estimate = estimateRun(
      segments.map((s) => ({ segmentId: s.id, segmentIndex: s.segmentIndex, durationMs: s.endMs - s.startMs })),
      candidates.map((m) => ({
        code: m.code,
        costPerSecond: m.code.startsWith('mock') || (m.capabilities as { billable?: boolean } | null)?.billable === false
          ? 0 : ratePerSecond(m, audio),
        // 제공자가 고정 길이만 받으면 과금 길이가 구간 길이와 다르다 — 4초 구간이 5초로 올라간다
        durations: (m.capabilities as { durations?: number[] } | null)?.durations ?? null,
      })),
      MAX_GENERATION_ATTEMPT,
    );
    return { ...estimate, models: candidates.map((m) => m.code), pinnedModel: pinned ?? null };
  }

  /** 수동 재생성도 큐를 바꾸기 전에 한도를 알려준다. 최종 판정은 모든 경로의 워커가 공유한다. */
  async assertRegenerationBudget(user: AuthUser, project: { config: unknown },
    segment: { id: string; segmentIndex: number; startMs: number; endMs: number }) {
    const cost = await this.estimateCost(project, [segment]);
    if (!cost.free) await this.spend.assertWithinBudget(user.orgId, cost.max);
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

    await this.prisma.$transaction(async (tx) => {
      await lockOrganizationSpend(tx, user.orgId);
      // 제출된 비용은 제공자 환불을 확인하기 전까지 보존한다.
      await tx.spendEntry.updateMany({ where: { orgId: user.orgId, projectId, status: 'RESERVED' },
        data: { status: 'RELEASED' } });
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
