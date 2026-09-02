import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@crez/db';
import { getProfileCentroids } from '@crez/db';
import { judgeAssignments } from '@crez/engine';
import {
  CrezError, ErrorCode, QUEUE, storageKey, TRACK_CENTROID_TOP_K,
} from '@crez/shared';
import { JOB_NAME, ProjectConfig, type SceneInput, type SetCastRequest } from '@crez/contracts';
import { PRISMA } from '../../common/prisma.module';
import { S3Service } from '../../common/storage/s3.service';
import { QueueService } from '../../common/queue/queue.service';
import { AuditService } from '../../common/audit/audit.service';
import { MlClient } from '../../common/ml/ml.client';
import { RightsService } from '../rights/rights.service';
import type { AuthUser } from '../../common/auth/auth.types';

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
        jobs: {
          orderBy: { attempt: 'desc' }, take: 1,
          include: { outputs: { include: { qcRuns: { orderBy: { createdAt: 'desc' }, take: 1 } } } },
        },
      },
    });
    return segments.map((s) => {
      const qc = s.jobs[0]?.outputs[0]?.qcRuns[0];
      return {
        id: s.id, segmentIndex: s.segmentIndex, sceneId: s.sceneId,
        startMs: s.startMs, endMs: s.endMs, status: s.status,
        attemptCount: s.attemptCount, acceptedOutputId: s.acceptedOutputId,
        latestScore: qc?.overallScore ? Number(qc.overallScore) : null,
        latestQcRunId: qc?.id ?? null,
      };
    });
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
