import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { prisma, deleteEmbeddingsForAsset, insertEmbedding, listEmbeddings, setProfileCentroids } from '@crez/db';
import {
  ASSET_QUALITY_POLICY, BODY_EMBEDDING_DIM, CrezError, ErrorCode, FACE_EMBEDDING_DIM,
  REQUIRED_BODY_SLOTS, REQUIRED_FACE_SLOTS, childLogger, storageKey,
} from '@crez/shared';
import { JOB_NAME, type AssetQualityJob, type ProfileBuildJob } from '@crez/contracts';
import { ml } from '../lib/ml';
import { storage } from '../lib/storage';
import { audit } from '../lib/audit';
import { judgeAsset } from '../lib/asset-judgement';
import { classifyCaptureSlot, shouldClassifySlot, slotSignalsFromLandmarks, type SlotGuess } from '../lib/asset-slot';

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

  // 슬롯 없이 올라온 사진은 먼저 분류한다. 수십·수백 장을 사람이 슬롯마다 고르게 할 수는 없다.
  // 영상 자산은 슬롯 개념이 없으므로 건드리지 않는다.
  //
  // 재검사(reclassify)면 이미 슬롯이 있어도 다시 분류한다 — 한 슬롯에 몰아서 올린 사진을
  // 재검사 한 번으로 제자리에 보내기 위한 경로다. 단, 사람이 직접 지정한 슬롯은 그대로 둔다.
  const manualSlot = (asset.qualityDetail as { manualSlot?: boolean } | null)?.manualSlot === true;
  const shouldClassify = shouldClassifySlot(asset, data.reclassify === true);

  let prescanned: Awaited<ReturnType<typeof ml.embedFace | typeof ml.embedBody>> | null = null;
  let slotGuess: SlotGuess | null = null;
  if (shouldClassify) {
    const classified = await classifyAndAssignSlot(asset, data.traceId, log);
    if (!classified) {
      // 분류하지 못한 사진은 사람이 슬롯을 정해 줄 때까지 둔다 — 억지로 끼워 넣으면 프로파일이 오염된다
      return { ok: false, unclassified: true, reason: 'UNCLASSIFIED' };
    }
    asset.captureSlot = classified.captureSlot;
    asset.assetType = classified.assetType;
    prescanned = classified.res;
    slotGuess = classified.guess;
  }

  const isFace = asset.assetType === 'FACE_IMAGE';
  const isBody = asset.assetType === 'BODY_IMAGE';
  if (!isFace && !isBody) {
    // 영상 자산은 Phase 1에서 프로파일 임베딩 대상이 아니다(모션 시그니처는 Phase 3 이후).
    log.info({ assetType: asset.assetType }, 'skip embedding for non-image asset');
    return { skipped: true };
  }

  // 분류 단계에서 이미 같은 측정을 했으면 그걸 쓴다 — 수백 장을 올리는 경로라 호출을 두 번 하지 않는다.
  const res = prescanned
    ?? (isFace
      ? await ml.embedFace({ imageKeys: [asset.storageKey], traceId: data.traceId })
      : await ml.embedBody({ imageKeys: [asset.storageKey], traceId: data.traceId }));

  const r = res.results[0];
  const face = r && 'bbox' in r ? r : null;
  const body = r && 'bodyInFrameRatio' in r ? r : null;
  const processed = !!r?.ok && !!r.vector;

  const verdict = judgeAsset({
    assetType: isFace ? 'FACE_IMAGE' : 'BODY_IMAGE',
    captureSlot: asset.captureSlot,
    ok: processed,
    error: r?.error ?? (r ? 'empty vector' : 'no result'),
    quality: r?.quality ?? null,
    imageWidth: r?.imageWidth,
    imageHeight: r?.imageHeight,
    faceHeight: isFace ? face?.bbox?.h : body?.faceBbox?.h,
    detectionScore: face?.detectionScore,
    faceCount: face?.faceCount,
    frontality: face?.frontality,
    bodyInFrameRatio: body?.bodyInFrameRatio,
  });
  const quality = processed ? (r?.quality ?? 0) : 0;

  // 재검사로 다시 들어온 자산이면 이전 판정의 임베딩을 지운다 — 같은 사진이 두 번 집계되지 않게.
  await deleteEmbeddingsForAsset(asset.id);
  await prisma.identityAsset.update({
    where: { id: asset.id },
    data: {
      qualityScore: quality,
      isUsable: verdict.usable,
      rejectReason: verdict.reason,
      // 자동 분류로 슬롯이 정해진 사진은 그 근거를 같이 남긴다 — 화면에서 확인 대상을 가려내야 한다.
      // manualSlot은 판정이 바뀌어도 유지한다. 이게 지워지면 다음 재검사가 사람이 정한 슬롯을 덮어쓴다.
      qualityDetail: {
        ...verdict.detail,
        ...(manualSlot ? { manualSlot: true } : {}),
        ...(slotGuess
          ? { autoSlot: true, classifierReason: slotGuess.reason, needsReview: slotGuess.needsReview }
          : {}),
      } as never,
      ...(face?.bbox ? { width: Math.round(face.bbox.w), height: Math.round(face.bbox.h) } : {}),
    },
  });

  if (!processed || !r?.vector) {
    log.warn({ error: r?.error, reason: verdict.reason }, 'embedding failed — asset marked unusable');
    return { ok: false, reason: verdict.reason, error: r?.error ?? null };
  }

  const usable = verdict.usable;
  if (usable) {
    // 전신 사진에도 얼굴이 찍혀 있다. 그 얼굴 임베딩을 버리면 얼굴 centroid가 클로즈업 사진만으로
    // 만들어지고, 인물이 멀리 잡히는 생성 영상과 기준의 성격이 어긋난다.
    //
    // 2026-09-21 실측(CRZ-A008, 같은 영상·같은 모델, centroid만 교체):
    //   클로즈업 4장으로 만든 centroid  → 얼굴 유사도 0.707
    //   전신 사진의 얼굴까지 포함(9장)  → 0.807
    // 0.1 차이는 합격선을 넘기고 못 넘기고를 가른다. 자산 종류가 아니라 "얼굴이 잡혔는가"로 판단한다.
    if (isBody) await embedFaceFromBodyImage(asset, data.traceId, quality, log);

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

  log.info({ quality, usable, reason: verdict.reason, detail: verdict.detail }, 'asset quality evaluated');
  return { ok: true, quality, usable, code: usable ? null : ErrorCode.IDN_ASSET_QUALITY, reason: verdict.reason };
}

/**
 * 슬롯 없이 올라온 사진을 측정해 분류하고 자산에 반영한다.
 *
 * 얼굴 측정은 항상 하고, 얼굴이 작을 때만 전신 비율을 추가로 잰다 —
 * 수백 장을 올리는 경로라 ML 호출을 필요한 만큼만 한다. 쓴 측정 결과는 그대로 돌려줘서
 * 뒤따르는 품질 판정이 같은 이미지를 다시 재지 않게 한다.
 *
 * 분류하지 못하면 슬롯을 비워 둔 채 사유만 남긴다. 반신 사진처럼 어느 쪽도 아닌 사진이 여기 온다.
 */
async function classifyAndAssignSlot(
  asset: { id: string; storageKey: string; captureSlot: string | null },
  traceId: string,
  log: ReturnType<typeof childLogger>,
): Promise<{
  captureSlot: string;
  assetType: 'FACE_IMAGE' | 'BODY_IMAGE';
  res: Awaited<ReturnType<typeof ml.embedFace | typeof ml.embedBody>>;
  guess: SlotGuess;
} | null> {
  const faceRes = await ml.embedFace({ imageKeys: [asset.storageKey], traceId });
  const f = faceRes.results[0];
  const frameH = f?.imageHeight ?? 0;
  const faceHeightRatio = f?.bbox && frameH ? f.bbox.h / frameH : null;
  const hasFace = !!f?.ok && !!f.bbox;

  // 얼굴이 화면에서 작으면 전신 사진일 수 있다. 그때만 전신 비율을 잰다.
  let bodyRes: Awaited<ReturnType<typeof ml.embedBody>> | null = null;
  let bodyInFrameRatio: number | null = null;
  if (!hasFace || (faceHeightRatio ?? 0) < ASSET_QUALITY_POLICY.minFaceHeightRatio) {
    bodyRes = await ml.embedBody({ imageKeys: [asset.storageKey], traceId });
    bodyInFrameRatio = bodyRes.results[0]?.bodyInFrameRatio ?? null;
  }

  const signals = slotSignalsFromLandmarks(f?.landmarks ?? null, f?.bbox?.w ?? null);
  const guess = classifyCaptureSlot({
    hasFace, faceHeightRatio, bodyInFrameRatio,
    signedNoseOffset: signals.signedNoseOffset,
    eyeDistanceRatio: signals.eyeDistanceRatio,
  });

  if (!guess.slot || !guess.assetType) {
    // 재분류였다면 원래 슬롯도 비운다 — 분류할 수 없는 사진을 엉뚱한 슬롯에 남겨 두면
    // 그 슬롯이 충족된 것처럼 보이고 프로파일에 그대로 들어간다.
    await prisma.identityAsset.update({
      where: { id: asset.id },
      data: {
        captureSlot: null,
        assetType: 'UNSORTED',
        isUsable: false,
        rejectReason: 'UNCLASSIFIED',
        qualityDetail: { ...guess.detail, classifierReason: guess.reason } as never,
      },
    });
    log.info({ assetId: asset.id, reason: guess.reason }, '슬롯을 분류하지 못했다 — 사람이 정해야 한다');
    return null;
  }

  // qualityDetail은 뒤이은 품질 판정이 덮어쓴다. 여기서는 슬롯만 정하고, 분류 근거는 호출자가 합쳐 넣는다.
  await prisma.identityAsset.update({
    where: { id: asset.id },
    data: { captureSlot: guess.slot, assetType: guess.assetType },
  });
  log.info(
    { assetId: asset.id, from: asset.captureSlot, slot: guess.slot, needsReview: guess.needsReview },
    `슬롯을 자동 분류했다 — ${guess.reason}`,
  );
  // 얼굴 슬롯은 얼굴 측정을, 전신 슬롯은 전신 측정을 그대로 넘긴다.
  // 전신으로 분류됐다면 위에서 반드시 전신 측정을 했으므로 bodyRes가 있다.
  return {
    captureSlot: guess.slot,
    assetType: guess.assetType,
    res: guess.assetType === 'FACE_IMAGE' ? faceRes : (bodyRes ?? faceRes),
    guess,
  };
}

/**
 * 전신 사진에서 얼굴 임베딩을 따로 뽑아 저장한다.
 *
 * 얼굴이 작거나 없으면 조용히 건너뛴다 — 이건 품질 판정이 아니라 기준 벡터를 두껍게 하려는 보강이고,
 * 여기서 실패해도 전신 사진 자체의 사용 여부(§8.1 판정)는 이미 정해져 있다.
 */
async function embedFaceFromBodyImage(
  asset: { id: string; identityId: string; storageKey: string },
  traceId: string,
  bodyQuality: number,
  log: ReturnType<typeof childLogger>,
): Promise<void> {
  try {
    const res = await ml.embedFace({ imageKeys: [asset.storageKey], traceId });
    const r = res.results[0];
    if (!r?.ok || !r.vector) return;

    await insertEmbedding({
      id: randomUUID(),
      identityId: asset.identityId,
      assetId: asset.id,
      kind: 'FACE',
      modelName: res.modelBundle.faceEmbedder,
      modelVersion: res.modelBundle.runtime,
      dim: r.dim ?? FACE_EMBEDDING_DIM,
      vector: r.vector,
      // 얼굴 품질로 가중한다 — 전신 사진의 신체 품질과는 다른 값이다
      quality: r.quality ?? bodyQuality,
    });
    log.info({ assetId: asset.id, faceHeight: r.bbox?.h }, '전신 사진에서 얼굴 임베딩을 추가로 저장했다');
  } catch (e) {
    log.warn({ assetId: asset.id, err: String(e) }, '전신 사진의 얼굴 임베딩 추출 실패 — 건너뛴다');
  }
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

  const allFace = await listEmbeddings(data.identityId, 'FACE');
  const bodyEmbeddings = await listEmbeddings(data.identityId, 'BODY');

  // 완전 측면(90°) 사진은 얼굴 centroid에서 뺀다.
  // 얼굴 인식 모델은 정면 위주로 학습돼 있어 90° 측면은 같은 사람인데도 다른 사람처럼 나온다 —
  // 2026-09-21 실측(CRZ-A008): 90° 사진이 본인의 다른 사진들과 0.169·0.182였고,
  // 이는 타인 분포(평균 0.143)와 구분되지 않는 수준이다.
  // 사진 자체는 보존한다 — 생성 레퍼런스로는 각도 다양성이 쓸모가 있기 때문이다(§11 REFERENCE_SWAP).
  // 통계적 이상치 제거(MAD)가 지금까지 우연히 걸러 주고 있었지만, 표본이 바뀌면 통과할 수 있어 규칙으로 못 박는다.
  const bySlot = new Map(assets.map((a) => [a.id, a.captureSlot]));
  const faceEmbeddings = allFace.filter((e) => {
    const slot = e.assetId ? bySlot.get(e.assetId) : null;
    return slot !== 'LEFT_90' && slot !== 'RIGHT_90';
  });
  const excludedProfileViews = allFace.length - faceEmbeddings.length;
  if (excludedProfileViews > 0) {
    log.info({ excludedProfileViews }, '90° 측면 얼굴은 centroid에서 제외했다 — 정면 학습 모델이 타인처럼 본다');
  }

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
