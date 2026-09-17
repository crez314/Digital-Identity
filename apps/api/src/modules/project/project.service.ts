import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@crez/db';
import { getProfileCentroids } from '@crez/db';
import { judgeAssignments } from '@crez/engine';
import {
  CrezError, ErrorCode, QUEUE, logger, storageKey, TRACK_CENTROID_TOP_K,
} from '@crez/shared';
import {
  JOB_NAME, ProjectConfig, type PromptReferenceUploadRequest, type SceneInput, type SetCastRequest,
  type UpdateProjectRequest,
} from '@crez/contracts';
import { PRISMA } from '../../common/prisma.module';
import { S3Service } from '../../common/storage/s3.service';
import { QueueService } from '../../common/queue/queue.service';
import { AuditService } from '../../common/audit/audit.service';
import { MlClient } from '../../common/ml/ml.client';
import { RightsService } from '../rights/rights.service';
import type { AuthUser } from '../../common/auth/auth.types';

/** 구간당 참고 이미지 상한 — Veo reference는 얼굴 포함 3장이라 이보다 많으면 대부분 전달되지 않는다 */
const MAX_REFERENCES_PER_SEGMENT = 6;
const REFERENCE_EXT: Record<PromptReferenceUploadRequest['contentType'], string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
};

@Injectable()
export class ProjectService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly s3: S3Service,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly ml: MlClient,
    private readonly rights: RightsService,
  ) {}

  async create(user: AuthUser, input: { title: string; projectType: string; config?: unknown }) {
    const config = ProjectConfig.parse(input.config ?? {});
    await this.assertPreferredModel(config.requiredMode, config.preferredModel);
    const p = await this.prisma.project.create({
      data: {
        orgId: user.orgId, title: input.title, projectType: input.projectType,
        status: 'DRAFT', config: config as never, createdBy: user.id,
      },
    });
    return this.toDto(p.id, user);
  }

  async toDto(id: string, user: AuthUser) {
    const p = await this.prisma.project.findFirst({ where: { id, orgId: user.orgId } });
    if (!p) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, undefined, { id }, 404);
    return {
      id: p.id, title: p.title, projectType: p.projectType, status: p.status,
      config: p.config as Record<string, unknown>, createdAt: p.createdAt.toISOString(),
    };
  }

  async list(user: AuthUser, params: { status?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(params.limit ?? 20, 100);
    const rows = await this.prisma.project.findMany({
      where: { orgId: user.orgId, ...(params.status ? { status: params.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    return {
      items: (hasMore ? rows.slice(0, limit) : rows).map((p) => ({
        id: p.id, title: p.title, projectType: p.projectType, status: p.status,
        config: p.config as Record<string, unknown>, createdAt: p.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? rows[limit - 1].id : null,
    };
  }

  private async requireProject(user: AuthUser, id: string) {
    const p = await this.prisma.project.findFirst({ where: { id, orgId: user.orgId } });
    if (!p) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, undefined, { id }, 404);
    return p;
  }

  /**
   * 지정 모델이 존재·활성이고 생성 방식을 지원하는지 저장 시점에 확인한다.
   * 생성 때 가서야 실패하면 원인을 찾기 어렵다.
   */
  private async assertPreferredModel(mode: string, code: string | undefined) {
    if (!code) return;
    const model = await this.prisma.aiModel.findUnique({ where: { code } });
    if (!model) throw new CrezError(ErrorCode.PRJ_INVALID_STATE, `모델 ${code}을(를) 찾을 수 없습니다`, { code }, 422);
    if (model.status !== 'ACTIVE') {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, `모델 ${code}이(가) 비활성 상태입니다`, { code, status: model.status }, 422);
    }
    const modes = (model.capabilities as { modes?: string[] }).modes ?? [];
    if (!modes.includes(mode)) {
      throw new CrezError(
        ErrorCode.PRJ_INVALID_STATE, `모델 ${code}은(는) ${mode} 방식을 지원하지 않습니다 (지원: ${modes.join(', ')})`,
        { code, mode, modes }, 422,
      );
    }
  }

  /**
   * §6.3 PATCH /projects/{id} — 제목과 생성 설정(방식·해상도·지정 모델).
   * 생성 설정은 생성 전(DRAFT·READY)에만 바꾼다. 이미 만든 결과와 설정이 어긋나면 이력을 설명할 수 없다.
   */
  async update(user: AuthUser, projectId: string, input: UpdateProjectRequest, traceId: string) {
    const project = await this.requireProject(user, projectId);
    if (project.status === 'ARCHIVED') {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, 'ARCHIVED 프로젝트는 수정할 수 없습니다', null, 409);
    }
    const before = { title: project.title, config: project.config };
    const data: { title?: string; config?: never } = {};
    if (input.title !== undefined) data.title = input.title;

    if (input.config) {
      if (!['DRAFT', 'READY'].includes(project.status)) {
        throw new CrezError(
          ErrorCode.PRJ_INVALID_STATE, `${project.status} 상태에서는 생성 설정을 바꿀 수 없습니다 — 생성 전에만 바꿀 수 있습니다`, null, 409,
        );
      }
      const config = { ...(project.config as Record<string, unknown>) };
      if (input.config.requiredMode) config.requiredMode = input.config.requiredMode;
      if (input.config.resolution) config.resolution = input.config.resolution;
      if (input.config.preferredModel === null) delete config.preferredModel;
      else if (input.config.preferredModel) config.preferredModel = input.config.preferredModel;
      // 방식만 바꿔도 기존 지정 모델이 새 방식을 지원하지 않을 수 있으므로 합친 결과로 검사한다
      await this.assertPreferredModel(String(config.requiredMode ?? 'pose-guided'), config.preferredModel as string | undefined);
      data.config = config as never;
    }

    const updated = await this.prisma.project.update({ where: { id: projectId }, data });
    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'PROJECT_UPDATED', projectId,
      payload: { before, after: { title: updated.title, config: updated.config } }, traceId,
    });
    return this.toDto(projectId, user);
  }

  /**
   * 프로젝트 삭제. 캐스팅·구간·생성 기록·결과 영상·QC·마스터가 함께 지워진다(FK CASCADE).
   * 감사 로그는 append-only라 남으며, 무엇을 지웠는지 요약을 기록한다(§14.2).
   */
  async remove(user: AuthUser, projectId: string, traceId: string) {
    const project = await this.requireProject(user, projectId);
    // 상태가 RUNNING이어도 실제로 도는 작업이 없으면(모델 선택 실패, 취소 후) 지울 수 있어야 한다
    const inFlight = await this.prisma.segment.count({ where: { projectId, status: { in: ['GENERATING', 'QC'] } } });
    if (inFlight > 0) {
      throw new CrezError(
        ErrorCode.PRJ_INVALID_STATE, `생성·QC가 진행 중인 구간 ${inFlight}개가 있어 삭제할 수 없습니다 — 먼저 취소하세요`, { inFlight }, 409,
      );
    }

    const [cast, segmentCount, generationJobCount, masters] = await Promise.all([
      this.prisma.projectCast.findMany({
        where: { projectId }, orderBy: { slotIndex: 'asc' },
        include: { identity: { select: { code: true } }, profile: { select: { version: true } } },
      }),
      this.prisma.segment.count({ where: { projectId } }),
      this.prisma.generationJob.count({ where: { segment: { projectId } } }),
      this.prisma.masterVideo.findMany({ where: { projectId }, select: { id: true, version: true, status: true, restricted: true } }),
    ]);

    // 대기 중인 재생성·QC 작업이 삭제된 행을 찾다가 실패하지 않게 먼저 큐에서 뺀다
    const removedQueueJobs = await this.queue.cancelByProject(projectId);
    await this.prisma.project.delete({ where: { id: projectId } });

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'PROJECT_DELETED', projectId,
      payload: {
        title: project.title, projectType: project.projectType, status: project.status, config: project.config,
        cast: cast.map((c) => ({ slotIndex: c.slotIndex, identityId: c.identityId, code: c.identity.code, profileVersion: c.profile.version })),
        segmentCount, generationJobCount, masters, removedQueueJobs,
      },
      traceId,
    });

    let deletedObjects = 0;
    try {
      deletedObjects = await this.s3.deletePrefix(`projects/${projectId}/`);
    } catch (e) {
      // DB 삭제는 끝났다. 남은 객체는 참조가 없으므로 요청은 성공으로 둔다.
      logger.warn({ traceId, projectId, err: String(e) }, 'project storage cleanup failed');
    }
    return { ok: true, deletedObjects };
  }

  /**
   * §6.3 PUT /projects/{id}/cast
   * 내부적으로 권리검사(게이트 1: 캐스팅) 후 profile version을 고정한다.
   * 이후 프로파일이 갱신되어도 이 프로젝트의 재생성 결과는 달라지지 않는다(§4.1).
   */
  async setCast(user: AuthUser, projectId: string, input: SetCastRequest, traceId: string) {
    const project = await this.requireProject(user, projectId);
    if (['RUNNING', 'COMPLETED', 'ARCHIVED'].includes(project.status)) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, `${project.status} 상태에서는 캐스팅을 변경할 수 없습니다`, null, 409);
    }

    const identityIds = input.cast.map((c) => c.identityId);
    // 위치(slotIndex)는 1번 위치(0)부터 빠짐없이 이어져야 한다 — 생성 요청에 이 순서로 인물이 전달된다.
    // 권리 검사(감사 기록이 남는다)보다 먼저 거른다.
    if (new Set(identityIds).size !== identityIds.length) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '같은 인물을 두 위치에 캐스팅할 수 없습니다', { identityIds }, 422);
    }
    const slots = input.cast.map((c) => c.slotIndex).sort((a, b) => a - b);
    if (slots.some((s, i) => s !== i)) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '위치는 1번부터 빠짐없이 순서대로 지정해야 합니다', { slots }, 422);
    }

    // 게이트 1 — 허용되지 않는 인물은 캐스트에 추가 불가 (§14.1)
    const rightsCheckId = await this.rights.enforce(
      user, { identityIds, usageType: input.usageType, territory: input.territory }, 'CASTING', traceId,
    );

    // 프로파일 버전 고정
    const resolved = [];
    for (const member of input.cast) {
      let profileId = member.profileId;
      if (!profileId) {
        const active = await this.prisma.identityProfile.findFirst({
          where: { identityId: member.identityId, status: 'ACTIVE' },
          orderBy: { version: 'desc' },
        });
        if (!active) {
          throw new CrezError(ErrorCode.IDN_PROFILE_NOT_ACTIVE, '활성 프로파일이 없어 캐스팅할 수 없습니다', { identityId: member.identityId }, 422);
        }
        profileId = active.id;
      }
      resolved.push({ ...member, profileId });
    }

    await this.prisma.$transaction([
      this.prisma.projectCast.deleteMany({ where: { projectId } }),
      ...resolved.map((m) =>
        this.prisma.projectCast.create({
          data: {
            projectId, identityId: m.identityId, profileId: m.profileId as string,
            slotIndex: m.slotIndex, roleLabel: m.roleLabel ?? null,
            appearance: m.appearance as never, rightsCheckId: rightsCheckId ?? null,
          },
        }),
      ),
    ]);

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'IDENTITY_USED', projectId,
      payload: { gate: 'CASTING', cast: resolved.map((m) => ({ identityId: m.identityId, profileId: m.profileId })) },
      traceId,
    });

    await this.refreshReadiness(projectId);
    return this.getCast(user, projectId);
  }

  async getCast(user: AuthUser, projectId: string) {
    await this.requireProject(user, projectId);
    const rows = await this.prisma.projectCast.findMany({
      where: { projectId },
      orderBy: { slotIndex: 'asc' },
      include: { identity: true, profile: true },
    });
    return rows.map((c) => ({
      id: c.id, identityId: c.identityId, identityCode: c.identity.code,
      displayName: c.identity.displayName, profileId: c.profileId,
      profileVersion: c.profile.version, slotIndex: c.slotIndex,
      roleLabel: c.roleLabel, appearance: c.appearance as Record<string, unknown>,
    }));
  }

  /** §6.3 소스 안무 영상 업로드 URL */
  async sourceUploadUrl(user: AuthUser, projectId: string, input: { fileName: string; contentType: string }) {
    await this.requireProject(user, projectId);
    const sourceVideoId = randomUUID();
    const key = storageKey.sourceVideo(projectId, sourceVideoId);
    const { url, expiresIn } = await this.s3.presignPut(key, input.contentType);
    await this.prisma.sourceVideo.create({
      data: { id: sourceVideoId, projectId, storageKey: key, analysisStatus: 'PENDING' },
    });
    return { sourceVideoId, storageKey: key, uploadUrl: url, expiresInSeconds: expiresIn };
  }

  /** §6.3 인물 검출·트래킹 분석 시작 → analysis 큐 (§8) */
  async analyzeSource(user: AuthUser, projectId: string, sourceVideoId: string, traceId: string) {
    await this.requireProject(user, projectId);
    const sv = await this.prisma.sourceVideo.findFirst({ where: { id: sourceVideoId, projectId } });
    if (!sv) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '소스 영상을 찾을 수 없음', { sourceVideoId }, 404);

    const head = await this.s3.head(sv.storageKey);
    if (!head.exists) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '업로드가 완료되지 않았습니다', { key: sv.storageKey }, 409);
    }

    await this.prisma.sourceVideo.update({ where: { id: sourceVideoId }, data: { analysisStatus: 'QUEUED' } });
    const jobId = await this.queue.add(QUEUE.ANALYSIS, JOB_NAME.SOURCE_ANALYZE, {
      traceId, orgId: user.orgId, projectId, sourceVideoId,
    });
    return { jobId, queue: QUEUE.ANALYSIS, traceId };
  }

  /**
   * §6.3 GET tracks — 검출된 트랙 + 자동 매핑 제안.
   * §9.1 5단계: τ_assign/δ_margin 미달 트랙은 확정하지 않고 운영자 확인 대상으로 올린다.
   */
  async getTracks(user: AuthUser, projectId: string, sourceVideoId: string) {
    await this.requireProject(user, projectId);
    const sv = await this.prisma.sourceVideo.findFirst({
      where: { id: sourceVideoId, projectId }, include: { tracks: { orderBy: { trackIndex: 'asc' } } },
    });
    if (!sv) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '소스 영상을 찾을 수 없음', { sourceVideoId }, 404);

    const cast = await this.prisma.projectCast.findMany({ where: { projectId } });
    const existing = await this.prisma.castMapping.findMany({ where: { projectId } });
    const byTrack = new Map(existing.map((m) => [m.sourceTrackId, m]));

    // 트랙 centroid ↔ 캐스트 profile centroid 유사도 행렬 → Hungarian (§9.1 3–4단계)
    let verdicts: Record<number, { identityId: string | null; similarity: number; margin: number | null; needsReview: boolean; runnerUpIdentityId: string | null }> = {};
    if (sv.tracks.length > 0 && cast.length > 0) {
      const centroids = await getProfileCentroids(cast.map((c) => c.profileId));
      const byProfile = new Map(centroids.map((c) => [c.id, c]));
      const trackCentroids = await this.prisma.$queryRawUnsafe<Array<{ id: string; track_index: number; face: string | null; quality: string | null }>>(
        `SELECT id, track_index, face_centroid::text AS face, quality::text AS quality
         FROM source_track WHERE source_video_id = $1::uuid ORDER BY track_index`,
        sourceVideoId,
      );

      const references = cast
        .map((c) => ({ identityId: c.identityId, centroid: byProfile.get(c.profileId)?.faceCentroid ?? null }))
        .filter((r): r is { identityId: string; centroid: number[] } => r.centroid !== null);

      if (references.length > 0) {
        const tracks = trackCentroids
          .map((t) => ({
            trackIndex: t.track_index,
            faceCentroid: t.face ? t.face.replace(/^\[|\]$/g, '').split(',').map(Number) : null,
            bodyCentroid: null,
            quality: t.quality ? Number(t.quality) : 0.5,
          }))
          .filter((t) => t.faceCentroid !== null);

        if (tracks.length > 0) {
          const assign = await this.ml.assignIdentity({
            tracks: tracks as never,
            references: references.map((r) => ({ identityId: r.identityId, faceCentroid: r.centroid })),
          });
          verdicts = Object.fromEntries(
            judgeAssignments(assign.assignments).map((v) => [v.trackIndex, v]),
          );
        }
      }
    }

    const castByIdentity = new Map(cast.map((c) => [c.identityId, c]));
    return {
      analysisStatus: sv.analysisStatus,
      tracks: sv.tracks.map((t) => {
        const confirmed = byTrack.get(t.id);
        const v = verdicts[t.trackIndex];
        return {
          id: t.id, trackIndex: t.trackIndex, startMs: t.startMs, endMs: t.endMs,
          quality: t.quality ? Number(t.quality) : null,
          confirmedMapping: confirmed
            ? { projectCastId: confirmed.projectCastId, method: confirmed.method, confidence: confirmed.confidence ? Number(confirmed.confidence) : null }
            : null,
          suggestion: v
            ? {
                projectCastId: v.identityId ? castByIdentity.get(v.identityId)?.id ?? null : null,
                identityId: v.identityId,
                confidence: Number((v as { confidence?: number }).confidence ?? 0),
                needsReview: v.needsReview,
                runnerUpMargin: v.margin,
              }
            : null,
        };
      }),
      topKFramesUsed: TRACK_CENTROID_TOP_K,
    };
  }

  /** §6.3 PUT mappings — 운영자 수정 반영. 수정 데이터는 자동 매핑 개선의 학습 신호로 축적한다(§9.1 6단계). */
  async confirmMappings(
    user: AuthUser, projectId: string,
    input: { mappings: Array<{ sourceTrackId: string; projectCastId: string; method: string }> },
    traceId: string,
  ) {
    await this.requireProject(user, projectId);

    await this.prisma.$transaction(
      input.mappings.map((m) =>
        this.prisma.castMapping.upsert({
          where: { projectId_sourceTrackId: { projectId, sourceTrackId: m.sourceTrackId } },
          update: { projectCastId: m.projectCastId, method: m.method, confirmedBy: user.id },
          create: {
            projectId, sourceTrackId: m.sourceTrackId, projectCastId: m.projectCastId,
            method: m.method, confirmedBy: user.id,
          },
        }),
      ),
    );

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'MAPPING_CONFIRMED', projectId,
      payload: { mappings: input.mappings }, traceId,
    });
    await this.refreshReadiness(projectId);
    return { confirmed: input.mappings.length };
  }

  /** §6.3 PUT scenes — 씬/세그먼트 분할 정의. Segment가 생성·QC·재생성의 최소 단위다(§4.1). */
  async setScenes(user: AuthUser, projectId: string, scenes: SceneInput[]) {
    const project = await this.requireProject(user, projectId);
    if (project.status === 'RUNNING') {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, 'RUNNING 중에는 씬을 재정의할 수 없습니다', null, 409);
    }
    // 씬 재정의는 세그먼트를 새로 만든다 — 세그먼트에 붙은 참고 이미지가 조용히 사라지지 않게 막는다
    const attached = await this.prisma.segmentReference.count({ where: { projectId, active: true } });
    if (attached > 0) {
      throw new CrezError(
        ErrorCode.PRJ_INVALID_STATE, `구간에 첨부한 참고 이미지 ${attached}장이 있어 구간을 다시 정의할 수 없습니다`, { attached }, 409,
      );
    }

    await this.prisma.$transaction([
      this.prisma.segment.deleteMany({ where: { projectId } }),
      this.prisma.scene.deleteMany({ where: { projectId } }),
    ]);

    let segmentIndex = 0;
    for (const s of scenes.sort((a, b) => a.sceneIndex - b.sceneIndex)) {
      if (s.endMs <= s.startMs) {
        throw new CrezError(ErrorCode.PRJ_INVALID_STATE, `씬 ${s.sceneIndex}: endMs가 startMs보다 커야 합니다`, s, 422);
      }
      const scene = await this.prisma.scene.create({
        data: {
          projectId, sceneIndex: s.sceneIndex, startMs: s.startMs, endMs: s.endMs,
          prompt: s.prompt ?? null, style: (s.style ?? null) as never,
        },
      });

      const bounds = [s.startMs, ...(s.segmentBoundariesMs ?? []).filter((b) => b > s.startMs && b < s.endMs).sort((a, b) => a - b), s.endMs];
      for (let i = 0; i < bounds.length - 1; i++) {
        await this.prisma.segment.create({
          data: {
            projectId, sceneId: scene.id, segmentIndex: segmentIndex++,
            startMs: bounds[i], endMs: bounds[i + 1], status: 'PENDING',
          },
        });
      }
    }

    await this.refreshReadiness(projectId);
    return this.listSegments(user, projectId);
  }

  async listSegments(user: AuthUser, projectId: string) {
    await this.requireProject(user, projectId);
    const segments = await this.prisma.segment.findMany({
      where: { projectId },
      orderBy: { segmentIndex: 'asc' },
      include: {
        scene: { select: { prompt: true } },
        jobs: {
          orderBy: { attempt: 'desc' }, take: 1,
          include: { outputs: { include: { qcRuns: { orderBy: { createdAt: 'desc' }, take: 1 } } } },
        },
        references: { where: { active: true, checksum: { not: 'pending' } }, orderBy: { createdAt: 'asc' } },
      },
    });
    return Promise.all(segments.map(async (s) => {
      const qc = s.jobs[0]?.outputs[0]?.qcRuns[0];
      const lastParams = s.jobs[0]?.params as
        | {
            prompt?: string | null;
            attachments?: Array<{ referenceId: string }>;
            imagePlan?: { droppedReferenceIds?: string[] };
          }
        | undefined;
      return {
        id: s.id, segmentIndex: s.segmentIndex, sceneId: s.sceneId,
        startMs: s.startMs, endMs: s.endMs, status: s.status,
        attemptCount: s.attemptCount, acceptedOutputId: s.acceptedOutputId,
        latestScore: qc?.overallScore ? Number(qc.overallScore) : null,
        latestQcRunId: qc?.id ?? null,
        prompt: s.prompt,
        scenePrompt: s.scene?.prompt ?? null,
        lastPrompt: lastParams ? (lastParams.prompt ?? null) : null,
        references: await Promise.all(s.references.map(async (r) => ({
          id: r.id, kind: r.kind, slotIndex: r.slotIndex, fileName: r.fileName,
          previewUrl: (await this.s3.presignGet(r.storageKey)).url,
          createdAt: r.createdAt.toISOString(),
        }))),
        lastReferenceIds: (lastParams?.attachments ?? []).map((a) => a.referenceId),
        lastDroppedReferenceIds: lastParams?.imagePlan?.droppedReferenceIds ?? [],
      };
    }));
  }

  private async requireEditableSegment(user: AuthUser, projectId: string, segmentId: string) {
    const project = await this.requireProject(user, projectId);
    if (project.status === 'ARCHIVED') {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, 'ARCHIVED 프로젝트는 수정할 수 없습니다', null, 409);
    }
    const segment = await this.prisma.segment.findFirst({ where: { id: segmentId, projectId } });
    if (!segment) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '세그먼트를 찾을 수 없음', { segmentId }, 404);
    return segment;
  }

  /**
   * 참고 이미지(배경·의상·헤어) 업로드 URL 발급 — 인물 자산과 같은 presigned PUT 흐름(§15).
   * 확정 전에는 checksum='pending'으로 두어 생성에 섞이지 않게 한다.
   */
  async createReferenceUploadUrl(
    user: AuthUser, projectId: string, segmentId: string, input: PromptReferenceUploadRequest,
  ) {
    await this.requireEditableSegment(user, projectId, segmentId);
    const count = await this.prisma.segmentReference.count({ where: { segmentId, active: true } });
    if (count >= MAX_REFERENCES_PER_SEGMENT) {
      throw new CrezError(
        ErrorCode.PRJ_INVALID_STATE, `참고 이미지는 구간당 ${MAX_REFERENCES_PER_SEGMENT}장까지 첨부할 수 있습니다`, { count }, 409,
      );
    }
    const referenceId = randomUUID();
    const key = storageKey.segmentReference(projectId, segmentId, referenceId, REFERENCE_EXT[input.contentType]);
    const { url, expiresIn } = await this.s3.presignPut(key, input.contentType);
    await this.prisma.segmentReference.create({
      data: {
        id: referenceId, projectId, segmentId, kind: input.kind, slotIndex: input.slotIndex ?? null,
        storageKey: key, fileName: input.fileName, contentType: input.contentType, checksum: 'pending',
      },
    });
    return { referenceId, uploadUrl: url, expiresInSeconds: expiresIn };
  }

  async confirmReference(
    user: AuthUser, projectId: string, segmentId: string, referenceId: string, input: { checksum: string }, traceId: string,
  ) {
    const segment = await this.requireEditableSegment(user, projectId, segmentId);
    const ref = await this.prisma.segmentReference.findFirst({ where: { id: referenceId, segmentId, active: true } });
    if (!ref) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '참고 이미지를 찾을 수 없음', { referenceId }, 404);
    const head = await this.s3.head(ref.storageKey);
    if (!head.exists) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '업로드된 파일이 스토리지에 없습니다', { referenceId }, 409);
    }
    await this.prisma.segmentReference.update({ where: { id: referenceId }, data: { checksum: input.checksum } });
    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'SEGMENT_REFERENCE_ADDED', projectId,
      payload: {
        segmentId, segmentIndex: segment.segmentIndex, referenceId, kind: ref.kind, slotIndex: ref.slotIndex,
        fileName: ref.fileName, checksum: input.checksum,
      },
      traceId,
    });
    return { id: referenceId, kind: ref.kind, slotIndex: ref.slotIndex };
  }

  /**
   * 참고 이미지 삭제. 생성 요청에 들어간 적이 있으면 이력을 설명할 수 있게 파일을 남기고 이후 생성에서만 뺀다.
   */
  async removeReference(user: AuthUser, projectId: string, segmentId: string, referenceId: string, traceId: string) {
    const segment = await this.requireEditableSegment(user, projectId, segmentId);
    const ref = await this.prisma.segmentReference.findFirst({ where: { id: referenceId, segmentId, active: true } });
    if (!ref) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '참고 이미지를 찾을 수 없음', { referenceId }, 404);

    const usedByJobs = await this.prisma.generationJob.count({
      where: { segmentId, params: { path: ['attachments'], array_contains: [{ referenceId }] } },
    });
    const base = { segmentId, segmentIndex: segment.segmentIndex, referenceId, kind: ref.kind, slotIndex: ref.slotIndex };

    if (usedByJobs > 0) {
      await this.prisma.segmentReference.update({ where: { id: referenceId }, data: { active: false } });
      await this.audit.record({
        orgId: user.orgId, actorId: user.id, action: 'SEGMENT_REFERENCE_REMOVED', projectId,
        payload: { ...base, mode: 'DEACTIVATED', usedByJobs }, traceId,
      });
      return { ok: true, mode: 'DEACTIVATED' as const };
    }

    await this.prisma.segmentReference.delete({ where: { id: referenceId } });
    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'SEGMENT_REFERENCE_REMOVED', projectId,
      payload: { ...base, mode: 'DELETED', storageKey: ref.storageKey, checksum: ref.checksum }, traceId,
    });
    try {
      await this.s3.delete(ref.storageKey);
    } catch (e) {
      logger.warn({ traceId, referenceId, err: String(e) }, 'segment reference object delete failed');
    }
    return { ok: true, mode: 'DELETED' as const };
  }

  /**
   * 실패·검토 대기 구간을 다시 생성할 수 있게 되돌린다 (§5.1).
   *
   * 시도 한도를 모두 쓴 구간은 재생성 사다리(§11)로도 되살릴 수 없다 — 제출 자체가 실패해 QC 결과가 없으면
   * 전략을 정할 수 없기 때문이다. 원인이 설정 문제(예: 레퍼런스 공개 URL 미설정)였다면 구간만 되돌려
   * 다시 돌릴 수 있어야 한다. 생성 기록(generation_job)과 감사 로그는 지우지 않는다.
   */
  async resetSegment(user: AuthUser, projectId: string, segmentId: string, traceId: string) {
    await this.requireProject(user, projectId);
    const segment = await this.prisma.segment.findFirst({ where: { id: segmentId, projectId } });
    if (!segment) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '세그먼트를 찾을 수 없음', { segmentId }, 404);
    if (['GENERATING', 'QC'].includes(segment.status)) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, `${segment.status} 중에는 초기화할 수 없습니다 — 먼저 취소하세요`, null, 409);
    }
    if (segment.acceptedOutputId) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '이미 승인된 구간입니다 — 초기화 대상이 아닙니다', null, 409);
    }

    await this.prisma.segment.update({
      where: { id: segmentId }, data: { status: 'PENDING', attemptCount: 0 },
    });
    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'PROJECT_GENERATED', projectId,
      payload: {
        event: 'SEGMENT_RESET', segmentId, segmentIndex: segment.segmentIndex,
        from: segment.status, attemptCountBefore: segment.attemptCount,
      },
      traceId,
    });
    return { ok: true, segmentId, status: 'PENDING' as const };
  }

  /**
   * 세그먼트별 프롬프트 수정 (§6.3). 비우면 씬 프롬프트로 돌아간다.
   * 이미 제출된 생성에는 반영되지 않고 다음 시도(재생성 포함)부터 쓰인다 — 실제로 쓴 값은 job params에 남는다.
   */
  async updateSegmentPrompt(
    user: AuthUser, projectId: string, segmentId: string, input: { prompt: string | null }, traceId: string,
  ) {
    const project = await this.requireProject(user, projectId);
    if (project.status === 'ARCHIVED') {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, 'ARCHIVED 프로젝트는 수정할 수 없습니다', null, 409);
    }
    const segment = await this.prisma.segment.findFirst({ where: { id: segmentId, projectId } });
    if (!segment) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '세그먼트를 찾을 수 없음', { segmentId }, 404);

    const prompt = input.prompt?.trim() || null;
    if (prompt !== segment.prompt) {
      await this.prisma.segment.update({ where: { id: segmentId }, data: { prompt } });
      await this.audit.record({
        orgId: user.orgId, actorId: user.id, action: 'SEGMENT_PROMPT_CHANGED', projectId,
        payload: { segmentId, segmentIndex: segment.segmentIndex, before: segment.prompt, after: prompt }, traceId,
      });
    }
    return { id: segmentId, prompt };
  }

  /**
   * §5.2 프로젝트 생명주기.
   * DRAFT → (캐스팅·권리검사·소스매핑 완료) → READY
   */
  async refreshReadiness(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || !['DRAFT', 'READY'].includes(project.status)) return;

    const [castCount, segmentCount, tracks, mappings] = await Promise.all([
      this.prisma.projectCast.count({ where: { projectId } }),
      this.prisma.segment.count({ where: { projectId } }),
      this.prisma.sourceTrack.count({ where: { sourceVideo: { projectId } } }),
      this.prisma.castMapping.count({ where: { projectId } }),
    ]);

    // 소스 영상을 쓰지 않는 프로젝트(t2v 등)는 트랙 매핑을 요구하지 않는다.
    const mappingReady = tracks === 0 || mappings >= tracks;
    const ready = castCount > 0 && segmentCount > 0 && mappingReady;

    if (ready && project.status === 'DRAFT') {
      await this.prisma.project.update({ where: { id: projectId }, data: { status: 'READY' } });
    } else if (!ready && project.status === 'READY') {
      await this.prisma.project.update({ where: { id: projectId }, data: { status: 'DRAFT' } });
    }
  }

  /** 세그먼트 상태에 따라 프로젝트 상태를 갱신 (§5.2) */
  async refreshProjectStatus(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || !['RUNNING', 'REVIEW'].includes(project.status)) return;

    const grouped = await this.prisma.segment.groupBy({
      by: ['status'], where: { projectId }, _count: true,
    });
    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count]));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return;

    if ((counts.PASSED ?? 0) === total) {
      await this.prisma.project.update({ where: { id: projectId }, data: { status: 'REVIEW' } });
      return;
    }
    // MANUAL_REVIEW가 있어도 프로젝트는 RUNNING에 머무르되 대시보드에 블로커로 표시한다(§5.2).
    if (project.status === 'REVIEW') {
      await this.prisma.project.update({ where: { id: projectId }, data: { status: 'RUNNING' } });
    }
  }

  async dashboard(user: AuthUser, projectId: string) {
    await this.requireProject(user, projectId);
    const grouped = await this.prisma.segment.groupBy({ by: ['status'], where: { projectId }, _count: true });
    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count]));
    const blockers = await this.prisma.segment.findMany({
      where: { projectId, status: 'MANUAL_REVIEW' },
      select: { id: true, segmentIndex: true, startMs: true, endMs: true, attemptCount: true },
      orderBy: { segmentIndex: 'asc' },
    });
    return { counts, blockers, blockerCount: blockers.length };
  }
}
