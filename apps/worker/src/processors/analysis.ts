import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { getProfileCentroids, prisma, setSourceTrackCentroid } from '@crez/db';
import { judgeAssignments } from '@crez/engine';
import { CrezError, ErrorCode, TRACK_CENTROID_TOP_K, childLogger, storageKey } from '@crez/shared';
import type { SourceAnalyzeJob } from '@crez/contracts';
import { ml } from '../lib/ml';
import { storage } from '../lib/storage';
import { emit } from '../lib/events';

/**
 * analysis 큐 (§8): 소스 영상 트래킹 + 자동 매핑 제안 (§9.1).
 *
 * 1. 인물 검출 후 트래킹하여 track 집합을 만든다
 * 2. 각 track에서 품질 상위 K개 프레임의 얼굴 임베딩으로 track centroid를 만든다
 * 3. track centroid와 캐스트 profile centroid 간 유사도 행렬
 * 4. Hungarian 알고리즘으로 전역 최적 1:1 할당 (crez-ml)
 * 5. τ_assign/δ_margin 미달 track은 확정하지 않고 운영자 확인 대상으로 올린다
 */
export async function analysisProcessor(job: Job): Promise<unknown> {
  const data = job.data as SourceAnalyzeJob;
  const log = childLogger({ traceId: data.traceId, projectId: data.projectId, sourceVideoId: data.sourceVideoId });

  const sv = await prisma.sourceVideo.findUnique({ where: { id: data.sourceVideoId } });
  if (!sv) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '소스 영상 없음', data, 404);

  await prisma.sourceVideo.update({ where: { id: sv.id }, data: { analysisStatus: 'RUNNING' } });
  await emit({ type: 'JOB_PROGRESS', projectId: data.projectId, payload: { stage: 'ANALYZE', progress: 0.1 }, traceId: data.traceId });

  const analysis = await ml.analyzeVideo({
    videoKey: sv.storageKey,
    sampleFps: Number(process.env.ANALYZE_SAMPLE_FPS ?? 5),
    maxPersons: 10,
    extractKeypoints: true,
    traceId: data.traceId,
  });

  await prisma.sourceVideo.update({
    where: { id: sv.id },
    data: {
      durationMs: analysis.durationMs, fps: analysis.fps,
      width: analysis.width, height: analysis.height,
    },
  });

  // 트랙 시계열(bbox/keypoint)은 크므로 스토리지에 두고 DB에는 키만 보관한다(§4.2 timeline_key).
  const tracksKey = storageKey.sourceTracks(data.projectId, sv.id);
  await storage.putJson(tracksKey, {
    videoKey: sv.storageKey, fps: analysis.fps, durationMs: analysis.durationMs,
    modelBundle: analysis.modelBundle,
    tracks: analysis.tracks.map((t) => ({
      trackIndex: t.trackIndex, startMs: t.startMs, endMs: t.endMs, frames: t.frames,
    })),
  });

  await prisma.sourceTrack.deleteMany({ where: { sourceVideoId: sv.id } });
  const created: Array<{ id: string; trackIndex: number }> = [];
  for (const t of analysis.tracks) {
    const id = randomUUID();
    await prisma.sourceTrack.create({
      data: {
        id, sourceVideoId: sv.id, trackIndex: t.trackIndex,
        startMs: t.startMs, endMs: t.endMs, timelineKey: tracksKey, quality: t.quality,
      },
    });
    if (t.faceCentroid) await setSourceTrackCentroid(id, t.faceCentroid);
    created.push({ id, trackIndex: t.trackIndex });
  }

  await emit({ type: 'JOB_PROGRESS', projectId: data.projectId, payload: { stage: 'ANALYZE', progress: 0.7, tracks: created.length }, traceId: data.traceId });

  // ── 자동 매핑 제안 ────────────────────────────────────
  const cast = await prisma.projectCast.findMany({ where: { projectId: data.projectId } });
  let autoConfirmed = 0;
  let needsReview = 0;

  if (cast.length > 0 && analysis.tracks.length > 0) {
    const centroids = await getProfileCentroids(cast.map((c) => c.profileId));
    const byProfile = new Map(centroids.map((c) => [c.id, c]));
    const references = cast
      .map((c) => ({ identityId: c.identityId, faceCentroid: byProfile.get(c.profileId)?.faceCentroid ?? null }))
      .filter((r): r is { identityId: string; faceCentroid: number[] } => r.faceCentroid !== null);

    if (references.length > 0) {
      const assign = await ml.assignIdentity({
        tracks: analysis.tracks.map((t) => ({
          trackIndex: t.trackIndex,
          faceCentroid: t.faceCentroid,
          bodyCentroid: t.bodyCentroid,
          quality: t.quality,
          frames: t.frames.slice(0, TRACK_CENTROID_TOP_K).map((f) => ({
            ms: f.ms, faceVector: f.faceVector ?? null, faceQuality: f.faceQuality, occlusion: f.occlusion ?? 0,
          })),
        })),
        references,
        traceId: data.traceId,
      });

      const verdicts = judgeAssignments(assign.assignments);
      const trackIdByIndex = new Map(created.map((c) => [c.trackIndex, c.id]));
      const castByIdentity = new Map(cast.map((c) => [c.identityId, c.id]));

      for (const v of verdicts) {
        const sourceTrackId = trackIdByIndex.get(v.trackIndex);
        const projectCastId = v.identityId ? castByIdentity.get(v.identityId) : undefined;
        if (!sourceTrackId) continue;
        if (v.needsReview || !projectCastId) {
          needsReview += 1;
          continue; // 확정하지 않는다 — 운영자 확인 대상 (§9.1 5단계)
        }
        await prisma.castMapping.upsert({
          where: { projectId_sourceTrackId: { projectId: data.projectId, sourceTrackId } },
          update: { projectCastId, method: 'AUTO', confidence: v.confidence },
          create: { projectId: data.projectId, sourceTrackId, projectCastId, method: 'AUTO', confidence: v.confidence },
        });
        autoConfirmed += 1;
      }
    }
  }

  await prisma.sourceVideo.update({
    where: { id: sv.id },
    data: { analysisStatus: needsReview > 0 ? 'NEEDS_REVIEW' : 'COMPLETED', tracksKey },
  });

  await emit({
    type: 'JOB_PROGRESS', projectId: data.projectId,
    payload: { stage: 'ANALYZE', progress: 1, tracks: created.length, autoConfirmed, needsReview },
    traceId: data.traceId,
  });

  log.info({ tracks: created.length, autoConfirmed, needsReview }, 'source analysis complete');
  return {
    tracks: created.length, autoConfirmed, needsReview,
    code: needsReview > 0 ? ErrorCode.MAP_LOW_CONFIDENCE : null,
  };
}
