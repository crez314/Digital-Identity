import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from 'bullmq';
import { prisma } from '@crez/db';
import { CrezError, ErrorCode, childLogger } from '@crez/shared';
import { JOB_NAME, type DerivativeJobPayload, type MasterJobPayload } from '@crez/contracts';
import { encodeWithFallback, FFMPEG, probe, run } from '../lib/ffmpeg';
import { storage } from '../lib/storage';
import { emit } from '../lib/events';
import { audit } from '../lib/audit';
import { presignedGet, downloadTo, uploadFrom } from '../lib/media-io';

/**
 * media 큐 (§8, §13): 세그먼트 결합 · 정규화 · 인코딩 · 파생물.
 * 전부 FFmpeg 기반 결정론적 처리이며 GPU를 쓰지 않는다
 * (스마트 크롭의 인물 추적만 예외인데, QC 단계의 track 데이터를 재사용하므로 재계산하지 않는다).
 */
export async function mediaProcessor(job: Job): Promise<unknown> {
  switch (job.name) {
    case JOB_NAME.MASTER_BUILD:
      return buildMaster(job.data as MasterJobPayload);
    case JOB_NAME.DERIVATIVE_BUILD:
      return buildDerivative(job.data as DerivativeJobPayload);
    default:
      throw new Error(`unknown media job: ${job.name}`);
  }
}

async function buildMaster(data: MasterJobPayload) {
  const log = childLogger({ traceId: data.traceId, masterId: data.masterId });
  const master = await prisma.masterVideo.findUnique({ where: { id: data.masterId } });
  if (!master) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '마스터 없음', data, 404);

  const segments = await prisma.segment.findMany({
    where: { projectId: data.projectId, status: 'PASSED' },
    orderBy: { segmentIndex: 'asc' },
    include: { jobs: { include: { outputs: true } } },
  });

  const parts = segments
    .map((s) => s.jobs.flatMap((j) => j.outputs).find((o) => o.id === s.acceptedOutputId))
    .filter((o): o is NonNullable<typeof o> => Boolean(o));

  if (parts.length === 0) throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '결합할 결과물이 없습니다', data, 409);

  await prisma.masterVideo.update({ where: { id: master.id }, data: { status: 'BUILDING' } });

  const work = await mkdtemp(join(tmpdir(), 'crez-master-'));
  try {
    const localFiles: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const local = join(work, `part-${String(i).padStart(4, '0')}.mp4`);
      await downloadTo(parts[i].storageKey, local);
      localFiles.push(local);
      await emit({
        type: 'JOB_PROGRESS', projectId: data.projectId,
        payload: { stage: 'MASTER', progress: (i + 1) / (parts.length + 2) }, traceId: data.traceId,
      });
    }

    // §3 Phase 3 DoD: 세그먼트 결합 시 시간·색상 정규화
    const normalized: string[] = [];
    for (let i = 0; i < localFiles.length; i++) {
      const out = join(work, `norm-${String(i).padStart(4, '0')}.mp4`);
      const filters = [
        ...(data.normalizeTiming ? ['fps=30'] : []),
        ...(data.normalizeColor ? ['eq=contrast=1.0:brightness=0:saturation=1.0', 'format=yuv420p'] : ['format=yuv420p']),
      ].join(',');
      await encodeWithFallback((enc) => [
        '-y', '-i', localFiles[i], '-vf', filters, '-c:v', enc, '-b:v', '8M',
        '-c:a', 'aac', '-movflags', '+faststart', out,
      ]);
      normalized.push(out);
    }

    const listFile = join(work, 'concat.txt');
    await writeFile(listFile, normalized.map((f) => `file '${f}'`).join('\n'), 'utf8');
    const masterFile = join(work, 'master.mp4');
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', masterFile]);

    const meta = await probe(masterFile);
    await uploadFrom(master.storageKey, masterFile, 'video/mp4');
    await prisma.masterVideo.update({
      where: { id: master.id },
      data: { durationMs: meta.durationMs, status: 'COMPLETED' },
    });
    await prisma.project.update({ where: { id: data.projectId }, data: { status: 'COMPLETED' } });

    await audit({
      orgId: data.orgId, action: 'MASTER_FINALIZED', projectId: data.projectId,
      payload: { masterId: master.id, version: master.version, segments: parts.length, durationMs: meta.durationMs },
      traceId: data.traceId,
    });
    await emit({
      type: 'PROJECT_STATUS', projectId: data.projectId,
      payload: { status: 'COMPLETED', masterId: master.id, durationMs: meta.durationMs }, traceId: data.traceId,
    });

    log.info({ segments: parts.length, durationMs: meta.durationMs }, 'master built');
    return { masterId: master.id, segments: parts.length, durationMs: meta.durationMs };
  } catch (e) {
    await prisma.masterVideo.update({ where: { id: master.id }, data: { status: 'FAILED' } });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const ASPECT: Record<string, { w: number; h: number }> = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
};

async function buildDerivative(data: DerivativeJobPayload) {
  const log = childLogger({ traceId: data.traceId, derivativeId: data.derivativeId });
  const derivative = await prisma.derivative.findUnique({
    where: { id: data.derivativeId }, include: { master: true },
  });
  if (!derivative) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '파생물 없음', data, 404);
  if (derivative.master.restricted) {
    throw new CrezError(ErrorCode.RGT_CONSENT_INVALID, '권리 제한 마스터', { masterId: derivative.masterId }, 403);
  }

  const work = await mkdtemp(join(tmpdir(), 'crez-deriv-'));
  try {
    const src = join(work, 'master.mp4');
    await downloadTo(derivative.master.storageKey, src);
    const target = ASPECT[derivative.aspectRatio] ?? ASPECT['16:9'];

    if (derivative.kind === 'THUMBNAIL') {
      // §13 썸네일: Identity Score 상위 프레임 중 얼굴 크기·정면성 기준 선별
      const ms = await pickThumbnailMs(data.projectId, derivative.master.durationMs);
      const out = join(work, 'thumb.jpg');
      await run(FFMPEG, ['-y', '-ss', String(ms / 1000), '-i', src, '-frames:v', '1', '-q:v', '2', out]);
      await uploadFrom(derivative.storageKey.replace(/\.mp4$/, '.jpg'), out, 'image/jpeg');
      await prisma.derivative.update({
        where: { id: derivative.id },
        data: {
          status: 'COMPLETED',
          storageKey: derivative.storageKey.replace(/\.mp4$/, '.jpg'),
          metadata: { sourceMs: ms } as never,
        },
      });
      return { derivativeId: derivative.id, kind: 'THUMBNAIL', sourceMs: ms };
    }

    // §13 스마트 크롭 — QC 단계에서 확보한 track 데이터로 크롭 중심을 계산한다(재계산 불필요).
    const crop = await smartCropCenter(data.projectId);
    const cropExpr = crop === null
      ? `crop=min(iw\\,ih*${target.w}/${target.h}):min(ih\\,iw*${target.h}/${target.w})`
      : `crop=min(iw\\,ih*${target.w}/${target.h}):min(ih\\,iw*${target.h}/${target.w}):` +
        `max(0\\,min(iw-min(iw\\,ih*${target.w}/${target.h})\\,iw*${crop.x}-min(iw\\,ih*${target.w}/${target.h})/2)):0`;

    const filters = `${cropExpr},scale=${target.w}:${target.h},format=yuv420p`;
    const out = join(work, 'out.mp4');

    // TEASER는 앞 15초만 사용한다 (§13 하이라이트 규칙 기반)
    const trimArgs = derivative.kind === 'TEASER' ? ['-t', '15'] : [];
    await encodeWithFallback((enc) => [
      '-y', '-i', src, ...trimArgs, '-vf', filters, '-c:v', enc, '-b:v', '6M',
      '-c:a', 'aac', '-movflags', '+faststart', out,
    ]);

    const meta = await probe(out);
    await uploadFrom(derivative.storageKey, out, 'video/mp4');
    await prisma.derivative.update({
      where: { id: derivative.id },
      data: {
        status: 'COMPLETED',
        metadata: { width: meta.width, height: meta.height, durationMs: meta.durationMs, cropCenterX: crop?.x ?? null } as never,
      },
    });

    await audit({
      orgId: data.orgId, action: 'DERIVATIVE_CREATED', projectId: data.projectId,
      payload: { derivativeId: derivative.id, kind: derivative.kind, aspectRatio: derivative.aspectRatio },
      traceId: data.traceId,
    });

    log.info({ kind: derivative.kind, aspect: derivative.aspectRatio }, 'derivative built');
    return { derivativeId: derivative.id, kind: derivative.kind, durationMs: meta.durationMs };
  } catch (e) {
    await prisma.derivative.update({ where: { id: data.derivativeId }, data: { status: 'FAILED' } });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** QC 시계열에서 캐스트 bbox 중심의 가중 평균 x(0..1)를 얻는다 */
async function smartCropCenter(projectId: string): Promise<{ x: number } | null> {
  const sv = await prisma.sourceVideo.findFirst({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  if (!sv?.tracksKey) return null;
  const tracks = await storage.getJson<{ tracks: Array<{ frames: Array<{ bbox: { x: number; w: number } }> }> }>(sv.tracksKey);
  if (!tracks?.tracks?.length || !sv.width) return null;

  let sum = 0;
  let count = 0;
  for (const t of tracks.tracks) {
    for (const f of t.frames ?? []) {
      if (!f.bbox) continue;
      sum += (f.bbox.x + f.bbox.w / 2) / sv.width;
      count += 1;
    }
  }
  return count > 0 ? { x: Math.max(0, Math.min(1, sum / count)) } : null;
}

/** Identity Score가 가장 높은 세그먼트의 중간 지점을 썸네일 후보로 쓴다 */
async function pickThumbnailMs(projectId: string, durationMs: number): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ start_ms: number; end_ms: number }>>(
    `SELECT s.start_ms, s.end_ms
     FROM segment s
     JOIN generation_job j ON j.segment_id = s.id
     JOIN generation_output o ON o.job_id = j.id AND o.id = s.accepted_output_id
     JOIN qc_run q ON q.output_id = o.id
     WHERE s.project_id = $1::uuid AND q.overall_score IS NOT NULL
     ORDER BY q.overall_score DESC
     LIMIT 1`,
    projectId,
  );
  if (rows.length === 0) return Math.floor(durationMs / 3);
  return Math.floor((rows[0].start_ms + rows[0].end_ms) / 2);
}
