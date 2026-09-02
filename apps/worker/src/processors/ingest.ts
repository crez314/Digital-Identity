import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { prisma, insertEmbedding, listEmbeddings, setProfileCentroids } from '@crez/db';
import {
  BODY_EMBEDDING_DIM, CrezError, ErrorCode, FACE_EMBEDDING_DIM,
  REQUIRED_BODY_SLOTS, REQUIRED_FACE_SLOTS, childLogger, storageKey,
} from '@crez/shared';
import { JOB_NAME, type AssetQualityJob, type ProfileBuildJob } from '@crez/contracts';
import { ml } from '../lib/ml';
import { storage } from '../lib/storage';
import { audit } from '../lib/audit';

/** 자산 품질 하한 — 미달 자산은 프로파일 빌드에서 제외한다 (§17 CREZ-IDN-002) */
const MIN_ASSET_QUALITY = 0.4;
/** 임베딩 산포 상한 — 초과 시 동일 인물이 아닌 자산 혼입 의심 (§17 CREZ-IDN-003) */
const MAX_FACE_VARIANCE = 0.08;

/**
 * ingest 큐 (§8): 자산 품질검사 · 임베딩 추출 · 프로파일 빌드.
 */
export async function ingestProcessor(job: Job): Promise<unknown> {
  switch (job.name) {
    case JOB_NAME.ASSET_QUALITY:
      return assetQuality(job.data as AssetQualityJob);
    case JOB_NAME.PROFILE_BUILD:
      return profileBuild(job.data as ProfileBuildJob);
    default:
      throw new Error(`unknown ingest job: ${job.name}`);
  }
}

/**
 * 자산 1건의 품질 점수 산출 + 임베딩 추출.
 * 판정(사용 가능 여부)은 워커가 하고, ML은 점수만 돌려준다(§2.2).
 */
async function assetQuality(data: AssetQualityJob) {
  const log = childLogger({ traceId: data.traceId, assetId: data.assetId });
  const asset = await prisma.identityAsset.findUnique({ where: { id: data.assetId } });
  if (!asset) throw new CrezError(ErrorCode.IDN_NOT_FOUND, '자산 없음', data, 404);

  const isFace = asset.assetType === 'FACE_IMAGE';
  const isBody = asset.assetType === 'BODY_IMAGE';
  if (!isFace && !isBody) {
    // 영상 자산은 Phase 1에서 프로파일 임베딩 대상이 아니다(모션 시그니처는 Phase 3 이후).
    log.info({ assetType: asset.assetType }, 'skip embedding for non-image asset');
    return { skipped: true };
  }

  const res = isFace
    ? await ml.embedFace({ imageKeys: [asset.storageKey], traceId: data.traceId })
    : await ml.embedBody({ imageKeys: [asset.storageKey], traceId: data.traceId });

  const r = res.results[0];
  if (!r?.ok || !r.vector) {
    await prisma.identityAsset.update({
      where: { id: asset.id }, data: { isUsable: false, qualityScore: 0 },
    });
    log.warn({ error: r?.error }, 'embedding failed — asset marked unusable');
    return { ok: false, reason: r?.error ?? 'no face detected' };
  }

  const quality = r.quality ?? 0;
  const usable = quality >= MIN_ASSET_QUALITY;

  await prisma.identityAsset.update({
    where: { id: asset.id },
    data: {
      qualityScore: quality,
      isUsable: usable,
      ...('bbox' in r && r.bbox ? { width: Math.round(r.bbox.w), height: Math.round(r.bbox.h) } : {}),
    },
  });

  if (usable) {
    // 개별 이미지 임베딩을 모두 보존해야 재생성 시 "다른 레퍼런스 선택" 전략이 가능하다(§4.1).
    await insertEmbedding({
      id: randomUUID(),
      identityId: asset.identityId,
      assetId: asset.id,
      kind: isFace ? 'FACE' : 'BODY',
      modelName: isFace ? res.modelBundle.faceEmbedder : (res.modelBundle.bodyDetector ?? 'body'),
      modelVersion: res.modelBundle.runtime,
      dim: r.dim ?? (isFace ? FACE_EMBEDDING_DIM : BODY_EMBEDDING_DIM),
      vector: r.vector,
      quality,
    });
  }

  log.info({ quality, usable }, 'asset quality evaluated');
  return { ok: true, quality, usable, code: usable ? null : ErrorCode.IDN_ASSET_QUALITY };
}

/**
 * 프로파일 빌드 (§6.1, §21 Identity Profile Generator).
 * 개별 임베딩을 집계해 centroid/variance를 만들고, 사용한 모델 버전을 고정한다.
 */
async function profileBuild(data: ProfileBuildJob) {
  const log = childLogger({ traceId: data.traceId, identityId: data.identityId, version: data.version });

  const assets = await prisma.identityAsset.findMany({
    where: { identityId: data.identityId, isUsable: true },
  });
  const filled = new Set(assets.map((a) => a.captureSlot).filter(Boolean) as string[]);
  const missing = [...REQUIRED_FACE_SLOTS, ...REQUIRED_BODY_SLOTS].filter((s) => !filled.has(s));
  if (missing.length > 0) {
    await prisma.identityProfile.update({ where: { id: data.profileId }, data: { status: 'FAILED' } });
    throw new CrezError(ErrorCode.IDN_SLOT_INCOMPLETE, undefined, { missingSlots: missing }, 422);
  }

  const faceEmbeddings = await listEmbeddings(data.identityId, 'FACE');
  const bodyEmbeddings = await listEmbeddings(data.identityId, 'BODY');
  if (faceEmbeddings.length === 0) {
    await prisma.identityProfile.update({ where: { id: data.profileId }, data: { status: 'FAILED' } });
    throw new CrezError(ErrorCode.IDN_ASSET_QUALITY, '사용 가능한 얼굴 임베딩이 없습니다', null, 422);
  }

  const faceAgg = await ml.aggregate({
    vectors: faceEmbeddings.map((e) => ({ id: e.id, vector: e.vector, quality: e.quality })),
    outlierSigma: 3.0,
    traceId: data.traceId,
  });

  // §17 CREZ-IDN-003 — 산포가 과다하면 동일 인물이 아닌 자산이 섞였을 가능성이 높다.
  if (faceAgg.variance > MAX_FACE_VARIANCE) {
    await prisma.identityProfile.update({
      where: { id: data.profileId },
      data: { status: 'FAILED', faceVariance: faceAgg.variance },
    });
    const outlierAssets = faceEmbeddings.filter((e) => faceAgg.outlierIds.includes(e.id)).map((e) => e.assetId);
    throw new CrezError(
      ErrorCode.IDN_EMBEDDING_VARIANCE,
      undefined,
      { variance: faceAgg.variance, threshold: MAX_FACE_VARIANCE, outlierAssetIds: outlierAssets },
      422,
    );
  }

  const bodyAgg = bodyEmbeddings.length > 0
    ? await ml.aggregate({
        vectors: bodyEmbeddings.map((e) => ({ id: e.id, vector: e.vector, quality: e.quality })),
        outlierSigma: 3.0, traceId: data.traceId,
      })
    : null;

  const modelBundle = {
    faceEmbedder: faceEmbeddings[0]?.modelName ?? 'unknown',
    faceEmbedderVersion: faceEmbeddings[0]?.modelVersion ?? 'unknown',
    bodyEmbedder: bodyEmbeddings[0]?.modelName ?? null,
    aggregatedAt: new Date().toISOString(),
  };

  const attributes = {
    assetCount: assets.length,
    faceEmbeddingCount: faceEmbeddings.length,
    bodyEmbeddingCount: bodyEmbeddings.length,
    outlierAssetIds: faceEmbeddings.filter((e) => faceAgg.outlierIds.includes(e.id)).map((e) => e.assetId),
    meanPairwiseSimilarity: faceAgg.meanPairwiseSimilarity,
    capturedSlots: [...filled],
  };

  await prisma.identityProfile.update({
    where: { id: data.profileId },
    data: {
      status: 'ACTIVE',
      faceVariance: faceAgg.variance,
      attributes: attributes as never,
      modelBundle: modelBundle as never,
      builtAt: new Date(),
    },
  });
  await setProfileCentroids(data.profileId, faceAgg.centroid, bodyAgg?.centroid ?? null);

  // 이전 ACTIVE 프로파일은 ARCHIVED로 내린다. 이미 pin한 프로젝트는 영향받지 않는다(§4.1).
  await prisma.identityProfile.updateMany({
    where: { identityId: data.identityId, status: 'ACTIVE', id: { not: data.profileId } },
    data: { status: 'ARCHIVED' },
  });
  await prisma.identity.update({ where: { id: data.identityId }, data: { status: 'ACTIVE' } });

  // 재현성을 위해 매니페스트를 스토리지에도 남긴다(§15).
  await storage.putJson(storageKey.profileManifest(data.identityId, data.version), {
    identityId: data.identityId, version: data.version, modelBundle, attributes,
    faceVariance: faceAgg.variance, faceCentroidDim: faceAgg.dim,
    builtAt: new Date().toISOString(),
  });

  await audit({
    orgId: data.orgId, action: 'PROFILE_BUILT', identityId: data.identityId,
    payload: { profileId: data.profileId, version: data.version, ...attributes, modelBundle },
    traceId: data.traceId,
  });

  log.info({ variance: faceAgg.variance, embeddings: faceEmbeddings.length }, 'profile built');
  return { profileId: data.profileId, version: data.version, variance: faceAgg.variance };
}
