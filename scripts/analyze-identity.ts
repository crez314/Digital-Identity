#!/usr/bin/env tsx
/**
 * CREZ Identity Consistency 분석 CLI.
 *
 *   pnpm analyze --reference ./samples/reference --video ./samples/generated.mp4 --output ./outputs
 *
 * 기준 인물 이미지들과 생성 영상을 받아 신원 일관성을 정량 평가하고,
 * 특허 실시예 자료로 쓸 수 있는 산출물을 남긴다.
 *
 *   outputs/identity_report.json   종합 결과
 *   outputs/frame_metrics.csv      프레임 단위 원시 데이터
 *   outputs/similarity_graph.png   시계열 그래프
 *
 * **계층 분리**
 *   특징 추출 : crez-ml (외부 모델. 교체 가능)
 *   판정·융합 : @crez/engine (CREZ 자체 구현. 단일 출처)
 * CLI는 둘을 잇고 산출물을 쓰는 역할만 한다 — 판정 로직을 여기에 복제하지 않는다.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  computeSeverity, embeddingVariance, euclideanFromCosine, fuse, linearNormalizer, makeNormalizer,
  seriesStats, type DriftSummary, type FusionWeights, type SeriesStats,
  type SeverityThresholds, type SeverityWeights,
} from '@crez/engine';

// ── 인자 파싱 ────────────────────────────────────────────
interface Args {
  reference: string;
  video: string;
  output: string;
  samplingFps: number;
  config: string | null;
  label: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string): string => {
    const i = argv.indexOf(flag);
    if (i === -1 || i === argv.length - 1) {
      if (fallback !== undefined) return fallback;
      throw new Error(`필수 인자 누락: ${flag}`);
    }
    return argv[i + 1];
  };
  return {
    reference: resolve(get('--reference')),
    video: resolve(get('--video')),
    output: resolve(get('--output', './outputs')),
    samplingFps: Number(get('--sampling-fps', '2')),
    config: argv.includes('--config') ? resolve(get('--config')) : null,
    label: get('--label', 'reference_person'),
  };
}

// ── 판정 파라미터 (코드에 상수를 두지 않는다) ─────────────
interface ScoringConfig {
  weights: FusionWeights;
  severityWeights: SeverityWeights;
  thresholds: SeverityThresholds & { driftMinDurationFrames: number };
  normalization: { face: { floor: number; ceiling: number }; body: { floor: number; ceiling: number } };
  tailWeight: number;
}

const DEFAULT_SCORING: ScoringConfig = {
  weights: { faceIdentity: 0.40, bodyIdentity: 0.25, temporalFace: 0.15, temporalBody: 0.10, driftPenalty: 0.10 },
  severityWeights: { faceDrop: 0.35, bodyDrop: 0.20, faceInstability: 0.20, bodyInstability: 0.10, duration: 0.15 },
  thresholds: {
    faceSimilarityThreshold: 0.70,
    bodySimilarityThreshold: 0.65,
    faceTemporalDeltaThreshold: 0.18,
    bodyTemporalDeltaThreshold: 0.20,
    durationSaturationSec: 2.0,
    driftMinDurationFrames: 3,
  },
  normalization: { face: { floor: 0.20, ceiling: 0.95 }, body: { floor: 0.20, ceiling: 0.95 } },
  tailWeight: 0.30,
};

/**
 * 판정 파라미터를 설정 파일에서 읽는다 (§11 — 코드에 weight를 박지 않는다).
 * 명시 경로 > configs/scoring.yaml > 코드 기본값 순으로 적용한다.
 */
function loadScoring(explicit: string | null): ScoringConfig & { calibration?: unknown } {
  const path = explicit ?? resolve('configs/scoring.yaml');
  if (!existsSync(path)) {
    console.warn(`      설정 파일 없음, 코드 기본값 사용: ${path}`);
    return DEFAULT_SCORING;
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = (path.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw)) as Partial<ScoringConfig>;
  return {
    ...DEFAULT_SCORING,
    ...parsed,
    weights: { ...DEFAULT_SCORING.weights, ...(parsed.weights ?? {}) },
    severityWeights: { ...DEFAULT_SCORING.severityWeights, ...(parsed.severityWeights ?? {}) },
    thresholds: { ...DEFAULT_SCORING.thresholds, ...(parsed.thresholds ?? {}) },
    normalization: { ...DEFAULT_SCORING.normalization, ...(parsed.normalization ?? {}) },
  };
}

/** 의존성 없이 이 설정 파일이 쓰는 범위(중첩 매핑·스칼라·주석)만 처리한다. */
function parseYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; node: Record<string, unknown> }> = [{ indent: -1, node: root }];

  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim().replace(/\s+#.*$/, '');
    const idx = body.indexOf(':');
    if (idx === -1) continue;
    const key = body.slice(0, idx).trim();
    const rest = body.slice(idx + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    if (rest === '') {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key] = coerce(rest);
    }
  }
  return root;

  function coerce(v: string): unknown {
    const unquoted = v.replace(/^["']|["']$/g, '');
    if (unquoted !== v) return unquoted;
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null') return null;
    const n = Number(v);
    return Number.isFinite(n) && v !== '' ? n : v;
  }
}

// ── ML 서비스 ────────────────────────────────────────────
const ML = process.env.ML_BASE_URL ?? 'http://localhost:8000';
const ML_TOKEN = process.env.ML_INTERNAL_TOKEN ?? 'dev-internal-token';

async function ml<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ML}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': ML_TOKEN },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`crez-ml ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

// ── 로컬 파일 → 스토리지 ─────────────────────────────────
const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'crezadmin',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'crezadmin',
  },
});
const BUCKET = process.env.S3_BUCKET ?? 'crez-media';

async function upload(localPath: string, key: string, contentType: string): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: readFileSync(localPath), ContentType: contentType,
  }));
  return key;
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);

function referenceImages(dir: string): string[] {
  const stat = statSync(dir);
  if (stat.isFile()) return [dir];
  return readdirSync(dir)
    .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
    .map((f) => join(dir, f))
    .sort();
}

// ── 분석 파이프라인 (§19) ────────────────────────────────
//
// CLI와 분리해 두어 API 계층에서 그대로 호출할 수 있다.
//   analyzeIdentity({ reference, video, config }) → IdentityAnalysisResult
// 산출물 파일 쓰기는 이 함수 밖의 책임이다.

export interface AnalyzeInput {
  /** 기준 이미지 디렉터리 또는 파일 */
  reference: string;
  video: string;
  scoring?: ScoringConfig;
  samplingFps?: number;
  /** Identity 식별자. multi-person 확장 시 인물별로 하나씩 */
  referenceId?: string;
  personId?: string;
}

export type IdentityAnalysisResult = Awaited<ReturnType<typeof analyzeIdentity>>;

export async function analyzeIdentity(input: AnalyzeInput) {
  const scoring = input.scoring ?? loadScoring(null);
  const samplingFps = input.samplingFps ?? 2;
  const referenceId = input.referenceId ?? 'reference_person';
  const runId = randomUUID().slice(0, 8);
  return runPipeline({
    reference: resolve(input.reference),
    video: resolve(input.video),
    samplingFps, referenceId,
    personId: input.personId ?? referenceId,
    scoring, runId,
    log: () => undefined,
  });
}

// ── 파이프라인 본체 ──────────────────────────────────────
interface PipelineArgs {
  reference: string;
  video: string;
  samplingFps: number;
  referenceId: string;
  personId: string;
  scoring: ScoringConfig;
  runId: string;
  log: (msg: string) => void;
}

async function runPipeline(a: PipelineArgs) {
  const prefix = `poc/${a.runId}`;

  // 1) 기준 이미지 업로드 및 임베딩 (§4 Reference Identity)
  const images = referenceImages(a.reference);
  if (images.length === 0) throw new Error(`기준 이미지를 찾을 수 없습니다: ${a.reference}`);
  a.log(`[1/4] 기준 이미지 ${images.length}장 인코딩`);

  const imageKeys: string[] = [];
  for (const img of images) {
    imageKeys.push(await upload(img, `${prefix}/ref/${basename(img)}`, 'image/jpeg'));
  }

  const faceRes = await ml<{
    results: Array<{ imageKey: string; ok: boolean; error: string | null; vector: number[] | null; quality: number | null }>;
    modelBundle: Record<string, unknown>;
  }>('/v1/embed/face', { imageKeys });

  const usable = faceRes.results.filter((r) => r.ok && r.vector);
  if (usable.length === 0) {
    throw new Error(`기준 이미지에서 얼굴을 찾지 못했습니다: ${faceRes.results.map((r) => r.error).join(', ')}`);
  }
  a.log(`      얼굴 검출 ${usable.length}/${images.length}장`);

  // 2) 대표 Identity Vector — 단순 평균이 아니라 이상치 제거 + 품질 가중
  const agg = await ml<{ centroid: number[]; variance: number; outlierIds: string[]; usedIds: string[] }>(
    '/v1/profile/aggregate',
    { vectors: usable.map((r) => ({ id: r.imageKey, vector: r.vector, quality: r.quality })), outlierSigma: 3.0 },
  );

  // 신체 기준도 같은 방식으로 유도한 crop에서 만든다 — 구도가 다르면 비교가 성립하지 않는다
  let bodyCentroid: number[] | null = null;
  let bodyVariance: number | null = null;
  try {
    const bodyRes = await ml<{ results: Array<{ imageKey: string; ok: boolean; vector: number[] | null; quality: number | null }> }>(
      '/v1/embed/body', { imageKeys },
    );
    const bodyUsable = bodyRes.results.filter((r) => r.ok && r.vector);
    if (bodyUsable.length > 0) {
      const bodyAgg = await ml<{ centroid: number[]; variance: number }>('/v1/profile/aggregate', {
        vectors: bodyUsable.map((r) => ({ id: r.imageKey, vector: r.vector, quality: r.quality })),
        outlierSigma: 3.0,
      });
      bodyCentroid = bodyAgg.centroid;
      bodyVariance = bodyAgg.variance;
    }
  } catch (e) {
    a.log(`      신체 기준 생성 실패(얼굴만 진행): ${String(e).slice(0, 100)}`);
  }
  a.log(`[2/4] 대표 벡터 — 얼굴 산포 ${agg.variance.toFixed(5)}, 이상치 ${agg.outlierIds.length}장 제외`
    + (bodyCentroid ? ` / 신체 산포 ${(bodyVariance ?? 0).toFixed(5)}` : ' / 신체 기준 없음'));

  // 3) 영상 분석
  a.log(`[3/4] 영상 분석 (${a.samplingFps} fps 샘플링)`);
  const videoKey = await upload(a.video, `${prefix}/${basename(a.video)}`, 'video/mp4');

  const qc = await ml<{
    videoKey: string; durationMs: number;
    modelBundle: Record<string, unknown>;
    perIdentity: Array<{
      identityId: string;
      faceSimilarity: number; bodySimilarity: number | null;
      temporalConsistency: number; temporalBodyConsistency: number | null;
      motionConsistency: number | null; bindingStability: number; validFrameRatio: number;
      series: Array<{
        ms: number; similarity: number; frameQuality: number; occlusion: number;
        embeddingDelta: number | null; bodySimilarity: number | null; bodyDelta: number | null;
        trackIndex: number | null; nearestIdentityId: string | null;
      }>;
    }>;
  }>('/v1/qc/score', {
    videoKey,
    references: [{ identityId: a.referenceId, faceCentroid: agg.centroid, ...(bodyCentroid ? { bodyCentroid } : {}) }],
    sampleFps: a.samplingFps,
  });

  const m = qc.perIdentity[0];
  a.log(`      ${m.series.length}개 프레임 분석`);

  // 4) CREZ 판정 계층 (@crez/engine)
  a.log('[4/4] 신원 일관성 판정');
  const faceValues = m.series.filter((p) => p.similarity > 0).map((p) => p.similarity);
  const bodyValues = m.series.filter((p) => p.bodySimilarity !== null).map((p) => p.bodySimilarity as number);
  const faceStats = seriesStats(faceValues);
  const bodyStats: SeriesStats | null = bodyValues.length > 0 ? seriesStats(bodyValues) : null;

  const frameSec = 1 / Math.max(a.samplingFps, 0.1);
  let runLength = 0;
  const frames = m.series.map((p, i) => {
    const sig = {
      faceSimilarity: p.similarity, bodySimilarity: p.bodySimilarity,
      faceDelta: p.embeddingDelta, bodyDelta: p.bodyDelta, durationSec: 0,
    };
    const provisional = computeSeverity(sig, a.scoring.thresholds, a.scoring.severityWeights);
    runLength = provisional.reasons.length > 0 ? runLength + 1 : 0;
    const sev = computeSeverity(
      { ...sig, durationSec: runLength * frameSec }, a.scoring.thresholds, a.scoring.severityWeights,
    );
    const isDrift = sev.reasons.length > 0 && runLength >= a.scoring.thresholds.driftMinDurationFrames;
    return { index: i, point: p, severity: sev, isDrift, runLength };
  });

  const driftFrames = frames.filter((f) => f.isDrift);
  const severities = driftFrames.map((f) => f.severity.severity);
  let maxRun = 0; let cur = 0;
  for (const f of frames) { cur = f.isDrift ? cur + 1 : 0; maxRun = Math.max(maxRun, cur); }

  const drift: DriftSummary = {
    driftFrames: driftFrames.length,
    totalFrames: frames.length,
    maxSeverity: severities.length ? Math.max(...severities) : 0,
    averageSeverity: severities.length ? severities.reduce((x, y) => x + y, 0) / severities.length : 0,
    maxDurationSec: maxRun * frameSec,
  };

  const breakdown = fuse(
    { faceStats, bodyStats, temporalFace: m.temporalConsistency, temporalBody: m.temporalBodyConsistency, drift },
    a.scoring.weights,
    makeNormalizer(a.scoring.normalization.face),
    makeNormalizer(a.scoring.normalization.body),
    { tailWeight: a.scoring.tailWeight },
  );

  const normFace = linearNormalizer(a.scoring.normalization.face);
  const normBody = linearNormalizer(a.scoring.normalization.body);

  // §13 — 다중 인물 확장을 위해 person_id / track_id / reference_id를 함께 남긴다.
  // 현재는 1인이지만 스키마는 인물별 배열을 담을 수 있는 형태를 유지한다.
  const trackIds = [...new Set(m.series.map((p) => p.trackIndex).filter((t): t is number => t !== null))];

  const report = {
    reference_id: a.referenceId,
    person_id: a.personId,
    track_ids: trackIds,
    run_id: a.runId,
    generated_at: new Date().toISOString(),
    video: {
      filename: basename(a.video),
      duration: Number((qc.durationMs / 1000).toFixed(2)),
      sampling_fps: a.samplingFps,
      analyzed_frames: frames.length,
      sha256: createHash('sha256').update(readFileSync(a.video)).digest('hex').slice(0, 16),
    },
    reference: {
      images: images.length,
      faces_detected: usable.length,
      outliers_excluded: agg.outlierIds.length,
      face_embedding_variance: Number(agg.variance.toFixed(6)),
      body_embedding_variance: bodyVariance === null ? null : Number(bodyVariance.toFixed(6)),
      body_reference_available: bodyCentroid !== null,
    },
    face: {
      mean_similarity: normFace(faceStats.mean),
      min_similarity: normFace(faceStats.min),
      p05_similarity: normFace(faceStats.p05),
      p10_similarity: normFace(faceStats.p10),
      median_similarity: normFace(faceStats.median),
      std_dev: faceStats.stdDev,
      temporal_consistency: Number((m.temporalConsistency * 100).toFixed(1)),
      embedding_variance: embeddingVariance(m.series.map((p) => p.embeddingDelta)),
      raw_cosine: { mean: faceStats.mean, min: faceStats.min, p05: faceStats.p05 },
    },
    body: bodyStats
      ? {
          mean_similarity: normBody(bodyStats.mean),
          min_similarity: normBody(bodyStats.min),
          p05_similarity: normBody(bodyStats.p05),
          p10_similarity: normBody(bodyStats.p10),
          median_similarity: normBody(bodyStats.median),
          std_dev: bodyStats.stdDev,
          temporal_consistency: m.temporalBodyConsistency === null ? null : Number((m.temporalBodyConsistency * 100).toFixed(1)),
          embedding_variance: embeddingVariance(m.series.map((p) => p.bodyDelta)),
          raw_cosine: { mean: bodyStats.mean, min: bodyStats.min, p05: bodyStats.p05 },
          // §6 — 코사인과 유클리드를 함께 기록한다. 정규화 벡터에서 서로 대응한다.
          raw_euclidean: {
            mean: Number(euclideanFromCosine(bodyStats.mean).toFixed(4)),
            max: Number(euclideanFromCosine(bodyStats.min).toFixed(4)),
          },
        }
      : null,
    binding_stability: Number((m.bindingStability * 100).toFixed(1)),
    identity_drift: {
      drift_frames: drift.driftFrames,
      drift_ratio: Number((drift.driftFrames / Math.max(frames.length, 1)).toFixed(4)),
      max_severity: Number(drift.maxSeverity.toFixed(4)),
      average_severity: Number(drift.averageSeverity.toFixed(4)),
      max_duration_sec: Number(drift.maxDurationSec.toFixed(2)),
      spans: collapseSpans(frames, frameSec),
    },
    score_breakdown: breakdown,
    crez_identity_score: breakdown.finalScore,
    provenance: {
      encoders: qc.modelBundle,
      scoring_config: a.scoring,
      note: '외부 모델은 특징 추출만 담당한다. 판정·융합은 @crez/engine 자체 구현.',
    },
  };

  return { report, frames, breakdown, drift, faceStats, bodyStats };
}

// ── 메인 ─────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scoring = loadScoring(args.config);
  mkdirSync(args.output, { recursive: true });
  const runId = randomUUID().slice(0, 8);

  console.log(`CREZ Identity Consistency 분석  [run ${runId}]`);
  console.log(`  기준: ${args.reference}`);
  console.log(`  영상: ${args.video}\n`);

  const { report, frames, breakdown, drift, faceStats, bodyStats } = await runPipeline({
    reference: args.reference, video: args.video, samplingFps: args.samplingFps,
    referenceId: args.label, personId: args.label, scoring, runId,
    log: (m) => console.log(m),
  });

  const reportPath = join(args.output, 'identity_report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const csvPath = join(args.output, 'frame_metrics.csv');
  const header = 'frame,timestamp_sec,person_id,track_id,face_similarity,body_similarity,face_temporal_delta,body_temporal_delta,frame_quality,occlusion,drift,drift_severity,drift_reasons';
  const rows = frames.map((f) => {
    const p = f.point;
    return [
      f.index, (p.ms / 1000).toFixed(3), args.label,
      p.trackIndex === null ? '' : p.trackIndex,
      p.similarity.toFixed(6),
      p.bodySimilarity === null ? '' : p.bodySimilarity.toFixed(6),
      p.embeddingDelta === null ? '' : p.embeddingDelta.toFixed(6),
      p.bodyDelta === null ? '' : p.bodyDelta.toFixed(6),
      p.frameQuality.toFixed(4), p.occlusion.toFixed(4),
      f.isDrift ? 'true' : 'false', f.severity.severity.toFixed(4),
      `"${f.severity.reasons.join('|')}"`,
    ].join(',');
  });
  writeFileSync(csvPath, `${[header, ...rows].join('\n')}\n`);

  const graphPath = join(args.output, 'similarity_graph.png');
  try {
    execFileSync(
      process.env.PYTHON_BIN ?? resolve('services/ml/.venv/bin/python'),
      [resolve('services/ml/scripts/plot_metrics.py'), csvPath, graphPath, args.label],
      { stdio: 'pipe' },
    );
  } catch (e) {
    console.warn(`      그래프 생성 실패(무시): ${String(e).slice(0, 120)}`);
  }

  console.log('\n────────────────────────────────────────');
  console.log(`  CREZ Identity Score   ${breakdown.finalScore.toFixed(1)} / 100`);
  console.log('────────────────────────────────────────');
  console.log(`  얼굴 일치도      ${report.face.mean_similarity.toFixed(1)}  (raw cos ${faceStats.mean.toFixed(4)})`);
  console.log(`  신체 일치도      ${bodyStats ? report.body!.mean_similarity.toFixed(1) : '—'}`);
  console.log(`  얼굴 시간일관성  ${report.face.temporal_consistency.toFixed(1)}`);
  console.log(`  신체 시간일관성  ${report.body?.temporal_consistency ?? '—'}`);
  console.log(`  드리프트         ${drift.driftFrames}/${frames.length} 프레임 (최대 심각도 ${drift.maxSeverity.toFixed(2)})`);
  console.log(`  감점             -${breakdown.driftPenalty.toFixed(1)}`);
  console.log('\n산출물:');
  console.log(`  ${reportPath}`);
  console.log(`  ${csvPath}`);
  console.log(`  ${graphPath}`);
}

/** 연속된 드리프트 프레임을 구간으로 묶는다 — 운영자가 볼 단위는 프레임이 아니라 구간이다 */
function collapseSpans(
  frames: Array<{ point: { ms: number }; isDrift: boolean; severity: { severity: number; reasons: string[] } }>,
  frameSec: number,
) {
  const spans: Array<{ start_sec: number; end_sec: number; max_severity: number; reasons: string[] }> = [];
  let cur: typeof spans[number] | null = null;
  for (const f of frames) {
    if (f.isDrift) {
      const t = f.point.ms / 1000;
      if (!cur) cur = { start_sec: t, end_sec: t + frameSec, max_severity: f.severity.severity, reasons: [...f.severity.reasons] };
      else {
        cur.end_sec = t + frameSec;
        cur.max_severity = Math.max(cur.max_severity, f.severity.severity);
        for (const r of f.severity.reasons) if (!cur.reasons.includes(r)) cur.reasons.push(r);
      }
    } else if (cur) {
      spans.push(round(cur));
      cur = null;
    }
  }
  if (cur) spans.push(round(cur));
  return spans;

  function round(s: typeof spans[number]) {
    return {
      start_sec: Number(s.start_sec.toFixed(2)),
      end_sec: Number(s.end_sec.toFixed(2)),
      max_severity: Number(s.max_severity.toFixed(4)),
      reasons: s.reasons,
    };
  }
}

main().catch((e) => {
  console.error(`\n실패: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
