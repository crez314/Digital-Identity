import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@crez/db';
import { CrezError, ErrorCode, QUEUE, storageKey } from '@crez/shared';
import { JOB_NAME, QcThresholds } from '@crez/contracts';
import { checkSequenceConsistency, type SequenceSegmentScore } from '@crez/engine';
import { PRISMA } from '../../common/prisma.module';
import { QueueService } from '../../common/queue/queue.service';
import { AuditService } from '../../common/audit/audit.service';
import { S3Service } from '../../common/storage/s3.service';
import { RightsService } from '../rights/rights.service';
import type { AuthUser } from '../../common/auth/auth.types';

/** ruleset을 읽지 못했을 때만 쓰는 값 — 정상 경로에서는 qc_ruleset.thresholds가 기준이다 */
const DEFAULT_SEQUENCE_MAX_SPREAD = 0.15;

const ASPECT_BY_KIND: Record<string, string> = {
  SHORTS: '9:16', REELS: '9:16', TIKTOK: '9:16',
  TEASER: '16:9', THUMBNAIL: '16:9', GIF: '16:9',
};

@Injectable()
export class MasterService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly s3: S3Service,
    private readonly rights: RightsService,
  ) {}

  /**
   * §6.4 POST /projects/{id}/master — PASSED 세그먼트 결합.
   * §14.3 provenance로 전체 생성 이력을 봉인한다.
   */
  async createMaster(
    user: AuthUser, projectId: string,
    input: { normalizeColor: boolean; normalizeTiming: boolean; ignoreSequenceCheck?: boolean },
    traceId: string,
  ) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, orgId: user.orgId },
      include: { cast: { orderBy: { slotIndex: 'asc' }, include: { identity: true, profile: true } } },
    });
    if (!project) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, undefined, { projectId }, 404);

    // §14.1 마스터 결합도 신원이 담긴 콘텐츠를 새로 만드는 일이므로 게이트 2와 같은 기준으로 재검사한다.
    // 이 검사가 없으면 철회 후 결합한 마스터가 restricted=false로 생성되어 배포 차단을 우회한다.
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
      where: { projectId },
      orderBy: { segmentIndex: 'asc' },
      include: {
        jobs: {
          include: {
            model: true,
            outputs: { include: { qcRuns: { orderBy: { createdAt: 'desc' }, take: 1 } } },
          },
        },
      },
    });
    if (segments.length === 0) throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '세그먼트가 없습니다', null, 409);

    const notPassed = segments.filter((s) => s.status !== 'PASSED');
    if (notPassed.length > 0) {
      throw new CrezError(
        ErrorCode.PRJ_INVALID_STATE,
        'PASSED가 아닌 세그먼트가 남아 있어 마스터를 만들 수 없습니다',
        { pending: notPassed.map((s) => ({ segmentIndex: s.segmentIndex, status: s.status })) },
        409,
      );
    }

    // 구간별 QC는 "이 컷 안에서 인물이 유지되는가"만 본다. 컷을 수십 개 이어 붙이는 긴 영상에서는
    // 컷마다 합격해도 1번 컷과 12번 컷의 인물이 달라 보일 수 있어, 묶기 전에 컷 사이 편차를 한 번 더 본다.
    const sequence = await this.checkSequence(segments);
    if (!sequence.ok && !input.ignoreSequenceCheck) {
      throw new CrezError(
        ErrorCode.QC_BELOW_THRESHOLD,
        `구간 사이 인물 편차가 큽니다 — ${sequence.verdict.reasons.join(' / ')}. `
        + '해당 구간을 재생성하거나, 결과를 확인했다면 ignoreSequenceCheck로 진행하세요.',
        { sequence: sequence.verdict },
        409,
      );
    }

    const last = await this.prisma.masterVideo.findFirst({ where: { projectId }, orderBy: { version: 'desc' } });
    const version = (last?.version ?? 0) + 1;
    const masterId = randomUUID();

    // §14.3 provenance — 세그먼트/job/profile 버전 전체 이력
    const provenance = {
      spec: 'CREZ DICE v1.1',
      generatedAt: new Date().toISOString(),
      // 어떤 기준으로 통과시켰는지도 이력이다 — 건너뛰고 묶었다면 그 사실까지 남는다
      sequenceCheck: { ...sequence.verdict, ignored: Boolean(input.ignoreSequenceCheck) },
      project: { id: project.id, title: project.title, type: project.projectType, config: project.config },
      cast: project.cast.map((c) => ({
        identityId: c.identityId, identityCode: c.identity.code,
        profileId: c.profileId, profileVersion: c.profile.version,
        modelBundle: c.profile.modelBundle, appearance: c.appearance,
      })),
      segments: segments.map((s) => {
        const acceptedJob = s.jobs.find((j) => j.outputs.some((o) => o.id === s.acceptedOutputId));
        const output = acceptedJob?.outputs.find((o) => o.id === s.acceptedOutputId);
        return {
          segmentIndex: s.segmentIndex, startMs: s.startMs, endMs: s.endMs,
          attempts: s.attemptCount,
          acceptedOutputId: s.acceptedOutputId,
          storageKey: output?.storageKey ?? null,
          modelCode: acceptedJob?.model.code ?? null,
          seed: acceptedJob?.seed ? String(acceptedJob.seed) : null,
          routingTrace: acceptedJob?.routingTrace ?? null,
          qcRunId: output?.qcRuns[0]?.id ?? null,
          qcScore: output?.qcRuns[0]?.overallScore ? Number(output.qcRuns[0].overallScore) : null,
          rulesetVersion: output?.qcRuns[0]?.rulesetVersion ?? null,
          manuallyAccepted: s.acceptReason !== null,
          acceptReason: s.acceptReason,
        };
      }),
    };

    const master = await this.prisma.masterVideo.create({
      data: {
        id: masterId, projectId, version,
        storageKey: storageKey.master(projectId, version),
        durationMs: segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0),
        provenance: provenance as never,
      },
    });

    const jobId = await this.queue.add(QUEUE.MEDIA, JOB_NAME.MASTER_BUILD, {
      traceId, orgId: user.orgId, projectId, masterId,
      normalizeColor: input.normalizeColor, normalizeTiming: input.normalizeTiming,
    });

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'MASTER_FINALIZED', projectId,
      payload: {
        masterId, version, segmentCount: segments.length,
        sequenceOk: sequence.ok,
        sequenceIgnored: Boolean(input.ignoreSequenceCheck) && !sequence.ok,
        sequenceSpread: sequence.verdict.perIdentity.map((p) => ({ identityId: p.identityId, spread: p.spread })),
      },
      traceId,
    });

    return { masterId: master.id, version, jobId, queue: QUEUE.MEDIA, traceId };
  }

  /**
   * 채택된 결과물의 QC 점수를 구간 순서대로 모아 컷 사이 인물 편차를 본다.
   * 허용치는 ruleset에서 온다 — 코드에 박으면 프로젝트마다 다른 기준을 쓸 수 없다(§10).
   */
  private async checkSequence(
    segments: Array<{
      segmentIndex: number;
      acceptedOutputId: string | null;
      jobs: Array<{ outputs: Array<{ id: string; qcRuns: Array<{ perIdentity: unknown }> }> }>;
    }>,
  ) {
    // ruleset이 없거나 형식이 달라도 결합 자체를 막지는 않는다 — 그때는 기본 허용치로 검사한다
    const ruleset = await this.prisma.qcRuleset.findFirst({ where: { isActive: true } });
    const parsed = QcThresholds.safeParse(ruleset?.thresholds ?? {});
    const maxSpread = parsed.success ? parsed.data.sequenceMaxSpread : DEFAULT_SEQUENCE_MAX_SPREAD;

    const scores: SequenceSegmentScore[] = [];
    for (const s of segments) {
      const output = s.jobs.flatMap((j) => j.outputs).find((o) => o.id === s.acceptedOutputId);
      const perIdentityRaw = output?.qcRuns[0]?.perIdentity as Record<string, { score?: number }> | undefined;
      if (!perIdentityRaw) continue;   // 수동 승인 등으로 QC 기록이 없으면 비교에서 뺀다
      const perIdentity: Record<string, number> = {};
      for (const [identityId, m] of Object.entries(perIdentityRaw)) {
        if (typeof m?.score === 'number') perIdentity[identityId] = m.score;
      }
      if (Object.keys(perIdentity).length > 0) scores.push({ segmentIndex: s.segmentIndex, perIdentity });
    }

    const verdict = checkSequenceConsistency(scores, maxSpread);
    return { ok: verdict.ok, verdict };
  }

  async listMasters(user: AuthUser, projectId: string) {
    const rows = await this.prisma.masterVideo.findMany({
      where: { projectId, project: { orgId: user.orgId } },
      orderBy: { version: 'desc' },
      include: { derivatives: true },
    });
    return Promise.all(rows.map(async (m) => ({
      id: m.id, version: m.version, durationMs: m.durationMs,
      status: m.status, restricted: m.restricted, createdAt: m.createdAt.toISOString(),
      // 결합 전이거나 권리 제한이면 URL을 주지 않는다 — 없는 객체의 URL은 혼란만 만든다.
      downloadUrl:
        m.restricted || m.status !== 'COMPLETED' ? null : (await this.s3.presignGet(m.storageKey)).url,
      derivatives: m.derivatives.map((d) => ({ id: d.id, kind: d.kind, aspectRatio: d.aspectRatio, status: d.status })),
    })));
  }

  async getProvenance(user: AuthUser, masterId: string) {
    const m = await this.prisma.masterVideo.findFirst({
      where: { id: masterId, project: { orgId: user.orgId } },
    });
    if (!m) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '마스터를 찾을 수 없음', { masterId }, 404);
    return m.provenance;
  }

  /** §6.4 POST /masters/{id}/derivatives — §13 Content Factory */
  async createDerivatives(
    user: AuthUser, masterId: string,
    input: { kinds: string[]; aspectRatios?: string[] }, traceId: string,
  ) {
    const master = await this.prisma.masterVideo.findFirst({
      where: { id: masterId, project: { orgId: user.orgId } },
    });
    if (!master) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '마스터를 찾을 수 없음', { masterId }, 404);
    // §14.1 게이트 3 — 권리 철회로 RESTRICTED된 마스터는 파생물도 만들지 않는다.
    if (master.restricted) {
      throw new CrezError(ErrorCode.RGT_CONSENT_INVALID, '권리 제한으로 배포·파생이 차단된 마스터입니다', { masterId }, 403);
    }
    // 결합이 끝나지 않은 마스터에서는 파생물을 만들 수 없다. 파일이 아직 없다.
    if (master.status !== 'COMPLETED') {
      throw new CrezError(
        ErrorCode.PRJ_INVALID_STATE,
        `마스터 결합이 완료되지 않았습니다 (현재 ${master.status})`,
        { masterId, status: master.status }, 409,
      );
    }

    const created = [];
    for (let i = 0; i < input.kinds.length; i++) {
      const kind = input.kinds[i];
      const aspectRatio = input.aspectRatios?.[i] ?? ASPECT_BY_KIND[kind] ?? '16:9';
      const derivativeId = randomUUID();
      await this.prisma.derivative.create({
        data: {
          id: derivativeId, masterId, kind, aspectRatio,
          storageKey: storageKey.derivative(master.projectId, derivativeId),
          status: 'PENDING',
        },
      });
      const jobId = await this.queue.add(QUEUE.MEDIA, JOB_NAME.DERIVATIVE_BUILD, {
        traceId, orgId: user.orgId, projectId: master.projectId, masterId, derivativeId, kind, aspectRatio,
      });
      created.push({ derivativeId, kind, aspectRatio, jobId });
    }

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'DERIVATIVE_CREATED',
      projectId: master.projectId, payload: { masterId, created }, traceId,
    });
    return { created, traceId };
  }
}
