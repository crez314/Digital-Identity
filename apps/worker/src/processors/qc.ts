import type { Job } from 'bullmq';
import { getProfileCentroids, prisma } from '@crez/db';
import {
  classifyOutcome, compositeScore, detectAll, judgeMultiPerson,
  type DetectedFinding, type IdentitySeries,
} from '@crez/engine';
import {
  CrezError, ErrorCode, MAX_REGEN, childLogger, storageKey,
} from '@crez/shared';
import { JOB_NAME, QcThresholds, ScoreWeights, type QcJobPayload } from '@crez/contracts';
import { ml } from '../lib/ml';
import { storage } from '../lib/storage';
import { emit } from '../lib/events';
import { queues } from '../lib/queues';

/**
 * qc 큐 (§8): ML 추론 호출 → 규칙 적용 → finding 생성.
 *
 * §7 원칙: crez-ml은 점수와 원시 시계열만 반환하고 합격 여부를 판단하지 않는다.
 * 임계값 적용과 finding 생성은 여기(규칙 엔진)에서 하며, 적용한 ruleset 버전을
 * qc_run.ruleset_version에 기록해 재현 가능하게 한다.
 */
export async function qcProcessor(job: Job): Promise<unknown> {
  if (job.name !== JOB_NAME.QC_RUN) throw new Error(`unknown qc job: ${job.name}`);
  const data = job.data as QcJobPayload;
  const log = childLogger({ traceId: data.traceId, segmentId: data.segmentId, attempt: data.attempt });

  const output = await prisma.generationOutput.findUnique({
    where: { id: data.outputId },
    include: { job: { include: { segment: { include: { project: { include: { cast: true, sourceVideos: true } } } } } } },
  });
  if (!output) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '결과물 없음', data, 404);

  const segment = output.job.segment;
  const project = segment.project;

  // ── 활성 ruleset 로드 (§10 가중치·임계값 외부화) ──
  const rulesetRow = await prisma.qcRuleset.findFirst({ where: { isActive: true } });
  if (!rulesetRow) throw new CrezError(ErrorCode.QC_RULESET_NOT_FOUND, undefined, null, 500);
  const weights = ScoreWeights.parse(rulesetRow.weights);
  const thresholds = QcThresholds.parse(rulesetRow.thresholds);

  const qcRun = await prisma.qcRun.create({
    data: { outputId: output.id, rulesetVersion: rulesetRow.version, status: 'RUNNING' },
  });

  try {
    // ── ML 추론 (§7 /v1/qc/score, /v1/qc/artifact) ──
    const centroids = await getProfileCentroids(project.cast.map((c) => c.profileId));
    const byProfile = new Map(centroids.map((c) => [c.id, c]));
    const references = project.cast
      .map((c) => {
        const cen = byProfile.get(c.profileId);
        return cen?.faceCentroid
          ? { identityId: c.identityId, faceCentroid: cen.faceCentroid, bodyCentroid: cen.bodyCentroid }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (references.length === 0) {
      throw new CrezError(ErrorCode.IDN_PROFILE_NOT_ACTIVE, '참조 프로파일 centroid가 없습니다', null, 422);
    }

    const sourceVideo = project.sourceVideos[0] ?? null;
    const [scores, artifacts] = await Promise.all([
      ml.scoreQc({
        videoKey: output.storageKey,
        references,
        sourceTracksKey: sourceVideo?.tracksKey ?? null,
        sampleFps: Number(process.env.QC_SAMPLE_FPS ?? 5),
        traceId: data.traceId,
      }),
      ml.detectArtifacts({
        videoKey: output.storageKey,
        sampleFps: Number(process.env.QC_SAMPLE_FPS ?? 5),
        traceId: data.traceId,
      }),
    ]);

    // ── 규칙 엔진 적용 (§10.1 점수, §10.2 오류 패턴) ──
    const perIdentity: Record<string, Record<string, number | null>> = {};
    const scoreByIdentity: Record<string, number> = {};
    const findings: DetectedFinding[] = [];

    for (const m of scores.perIdentity) {
      const metrics = {
        faceSimilarity: m.faceSimilarity,
        bodySimilarity: m.bodySimilarity,
        temporalConsistency: m.temporalConsistency,
        motionConsistency: m.motionConsistency,
        bindingStability: m.bindingStability,
        validFrameRatio: m.validFrameRatio,
      };
      const score = compositeScore(metrics, weights);
      scoreByIdentity[m.identityId] = score;
      perIdentity[m.identityId] = { ...metrics, score };

      const series: IdentitySeries = {
        identityId: m.identityId,
        series: m.series.map((p) => ({
          ms: p.ms, similarity: p.similarity,
          runnerUpSimilarity: p.runnerUpSimilarity, runnerUpIdentityId: p.runnerUpIdentityId,
          nearestIdentityId: p.nearestIdentityId, trackIndex: p.trackIndex,
          frameQuality: p.frameQuality, occlusion: p.occlusion, embeddingDelta: p.embeddingDelta,
        })),
        trackSpans: m.trackSpans,
      };
      findings.push(...detectAll(series, thresholds));
    }

    // 아티팩트는 인물 귀속이 아니라 프레임 귀속이다 (§4.2 finding_type)
    for (const span of artifacts.spans) {
      if (span.kind === 'FRAME_ANOMALY') continue;
      findings.push({
        identityId: null,
        findingType: span.kind as DetectedFinding['findingType'],
        severity: span.score > 0.8 ? 'HIGH' : span.score > 0.5 ? 'MEDIUM' : 'LOW',
        startMs: span.startMs, endMs: span.endMs, confidence: span.score,
        evidence: { frameIndices: span.frameIndices, note: `${span.kind} score ${span.score.toFixed(3)}` },
      });
    }

    // ── §10.3 다중 인물 판정 ──
    const verdict = judgeMultiPerson(scoreByIdentity, thresholds);

    // ── finding 근거 프레임 썸네일 생성 (§10.2 "근거 없는 finding 금지") ──
    const thumbTargets = findings.slice(0, 20).map((f) => Math.round((f.startMs + f.endMs) / 2));
    let thumbByMs = new Map<number, string>();
    if (thumbTargets.length > 0) {
      try {
        const frames = await ml.extractFrames({
          videoKey: output.storageKey,
          timestampsMs: [...new Set(thumbTargets)],
          outputPrefix: `projects/${project.id}/segments/${segment.id}/attempt-${data.attempt}/qc/frames`,
          traceId: data.traceId,
        });
        thumbByMs = new Map(frames.frames.map((f) => [f.ms, f.key]));
      } catch (e) {
        // 썸네일 실패로 QC 전체를 실패시키지 않는다. 근거 텍스트는 남는다.
        log.warn({ err: String(e) }, 'evidence frame extraction failed');
      }
    }

    // ── 원시 시계열은 크므로 스토리지에 두고 키만 보관 ──
    const seriesKey = `projects/${project.id}/segments/${segment.id}/attempt-${data.attempt}/qc/series.json`;
    await storage.putJson(seriesKey, {
      qcRunId: qcRun.id, rulesetVersion: rulesetRow.version,
      modelBundle: scores.modelBundle, perIdentity: scores.perIdentity, artifacts: artifacts.spans,
    });

    await prisma.qcRun.update({
      where: { id: qcRun.id },
      data: {
        status: verdict.passed ? 'PASSED' : 'FAILED',
        overallScore: verdict.overallScore,
        perIdentity: perIdentity as never,
        seriesKey,
        modelBundle: scores.modelBundle as never,
      },
    });

    for (const f of findings) {
      const mid = Math.round((f.startMs + f.endMs) / 2);
      const thumb = thumbByMs.get(mid);
      await prisma.qcFinding.create({
        data: {
          qcRunId: qcRun.id, identityId: f.identityId, findingType: f.findingType,
          severity: f.severity, startMs: f.startMs, endMs: f.endMs, confidence: f.confidence,
          evidence: { ...f.evidence, thumbnailKeys: thumb ? [thumb] : [] } as never,
        },
      });
    }

    // ── §5.1 상태 전이 ──
    if (verdict.passed) {
      await closeOpenRegenTask(segment.id, verdict.overallScore);
      await prisma.segment.update({
        where: { id: segment.id }, data: { status: 'PASSED', acceptedOutputId: output.id },
      });
      await emit({
        type: 'QC_COMPLETED', projectId: project.id, segmentId: segment.id,
        payload: { status: 'PASSED', score: verdict.overallScore, qcRunId: qcRun.id, findings: findings.length },
        traceId: data.traceId,
      });
      await refreshProjectStatus(project.id, data.traceId);
      log.info({ score: verdict.overallScore }, 'QC passed');
      return { qcRunId: qcRun.id, passed: true, score: verdict.overallScore };
    }

    // QC 실패 → 재생성 큐 또는 MANUAL_REVIEW (§5.1)
    const regenCount = await prisma.regenerationTask.count({ where: { segmentId: segment.id } });
    if (segment.attemptCount >= MAX_REGEN || regenCount >= MAX_REGEN) {
      // 승격 전에 직전 재생성의 결과를 분류해 둔다. 여기서 빠뜨리면 outcome이 영원히
      // null로 남아 §11 전략별 통계와 §20 재생성 성공률 KPI가 어긋난다.
      await closeOpenRegenTask(segment.id, verdict.overallScore);
      await prisma.segment.update({ where: { id: segment.id }, data: { status: 'MANUAL_REVIEW' } });
      await emit({
        type: 'QC_COMPLETED', projectId: project.id, segmentId: segment.id,
        payload: {
          status: 'MANUAL_REVIEW', score: verdict.overallScore, qcRunId: qcRun.id,
          reasons: verdict.reasons, code: ErrorCode.QC_REGEN_LIMIT,
        },
        traceId: data.traceId,
      });
      log.warn({ score: verdict.overallScore, reasons: verdict.reasons }, 'QC failed — escalated to MANUAL_REVIEW');
      return { qcRunId: qcRun.id, passed: false, escalated: true };
    }

    await queues.regeneration.add(JOB_NAME.REGENERATION_PLAN, {
      traceId: data.traceId, orgId: data.orgId, projectId: project.id,
      segmentId: segment.id, qcRunId: qcRun.id,
    });

    await emit({
      type: 'QC_COMPLETED', projectId: project.id, segmentId: segment.id,
      payload: {
        status: 'FAILED', score: verdict.overallScore, qcRunId: qcRun.id,
        reasons: verdict.reasons, failingIdentityIds: verdict.failingIdentityIds,
        findings: findings.map((f) => ({ type: f.findingType, startMs: f.startMs, endMs: f.endMs, severity: f.severity })),
        code: ErrorCode.QC_BELOW_THRESHOLD,
      },
      traceId: data.traceId,
    });

    log.info({ score: verdict.overallScore, findings: findings.length }, 'QC failed — regeneration queued');
    return { qcRunId: qcRun.id, passed: false, findings: findings.length };
  } catch (e) {
    await prisma.qcRun.update({ where: { id: qcRun.id }, data: { status: 'ERROR' } });
    await prisma.segment.update({ where: { id: data.segmentId }, data: { status: 'MANUAL_REVIEW' } });
    throw e;
  }
}

/**
 * 결과가 나오지 않은 채 남아 있는 재생성 task의 outcome을 분류한다 (§11 이력 축적).
 * regeneration 큐를 다시 타지 않는 종료 경로(PASSED, MANUAL_REVIEW 승격)에서 호출한다.
 */
async function closeOpenRegenTask(segmentId: string, scoreAfter: number | null): Promise<void> {
  const open = await prisma.regenerationTask.findFirst({
    where: { segmentId, outcome: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!open) return;
  await prisma.regenerationTask.update({
    where: { id: open.id },
    data: {
      outcome: classifyOutcome(open.scoreBefore ? Number(open.scoreBefore) : null, scoreAfter),
      scoreAfter,
    },
  });
}

/** §5.2 모든 세그먼트가 PASSED면 프로젝트를 REVIEW로 올린다 */
async function refreshProjectStatus(projectId: string, traceId: string) {
  const grouped = await prisma.segment.groupBy({ by: ['status'], where: { projectId }, _count: true });
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0 && (counts.PASSED ?? 0) === total) {
    await prisma.project.update({ where: { id: projectId }, data: { status: 'REVIEW' } });
    await emit({ type: 'PROJECT_STATUS', projectId, payload: { status: 'REVIEW' }, traceId });
  }
}
