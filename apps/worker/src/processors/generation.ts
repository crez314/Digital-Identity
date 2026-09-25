import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import {
  generationDispatchId, getProfileCentroids, lockOrganizationSpend, markSpendFailed, reserveSpend,
  prisma, Prisma,
} from '@crez/db';
import {
  providerRegistry, route, StaticQuotaView,
  type GenerationRequest, type ModelDescriptor, type PromptAttachment, type ReferenceAsset,
} from '@crez/providers';
import {
  CrezError, ErrorCode, MAX_CHAIN_LENGTH, MAX_GENERATION_ATTEMPT, QUEUE,
  childLogger, storageKey, withIdentityAnchor, QUEUE_POLICY,
} from '@crez/shared';
import { inspectPrompt, summarizeRisks } from '@crez/engine';
import { JOB_NAME, type GenerationJobPayload, type GenerationPollJob } from '@crez/contracts';
import { emit } from '../lib/events';
import { audit } from '../lib/audit';
import { queues } from '../lib/queues';
import { finalizeGeneration } from '../lib/generation-finalize';
import { materializeOutput } from '../lib/materialize';
import { presignedGet } from '../lib/media-io';
import { presignReference } from '../lib/reference-image';
import {
  buildChainStartFrame, CHAIN_ASSET_PREFIX, isSyntheticAsset, PINNED_ASSET_PREFIX, shouldChain,
} from '../lib/chain-start';

/**
 * generation 큐 (§8, §12).
 * 라우팅 → 제출 → provider_job_id 저장 → 지연 폴링.
 * 워커 재시작으로 폴링이 유실되지 않도록 SUBMITTED 상태를 reconciler가 주기 스캔한다.
 */
export async function generationProcessor(job: Job): Promise<unknown> {
  switch (job.name) {
    case JOB_NAME.GENERATION_SUBMIT: {
      const data = job.data as GenerationJobPayload;
      try { return await submit(data); } catch (error) {
        // 제출 전에 준비가 실패한 경우 예약을 영구히 남기지 않는다.
        // SUBMITTED 예약은 외부 접수 여부가 불명확하므로 재제출/해제하지 않는다.
        const entry = await prisma.spendEntry.findUnique({
          where: { segmentId_attempt: { segmentId: data.segmentId, attempt: data.attempt } },
        });
        if (isLastAttempt(job) && (!entry || entry.status === 'RESERVED')) {
          await failRouting(data.segmentId, data.projectId!, data,
            error instanceof CrezError ? error : new CrezError(ErrorCode.GEN_PROVIDER_ERROR, String(error)));
        }
        throw error;
      }
    }
    case JOB_NAME.GENERATION_POLL:
      // 결과 수집/인계 장애는 큐 재시도가 끝나도 reconciler가 복구한다.
      return poll(
        job.data as GenerationPollJob & { projectId: string; segmentId: string; orgId: string },
        isLastAttempt(job),
      );
    case JOB_NAME.GENERATION_CANCEL:
      return cancelSubmission(job.data as CancelJob);
    default:
      throw new Error(`unknown generation job: ${job.name}`);
  }
}

/**
 * 구간 번호를 대표 사진 자리로 돌린다.
 * 사진이 1장뿐이면 돌릴 것이 없고, 사진이 없으면 -1(대표 없음)이다.
 * 같은 구간은 항상 같은 사진을 쓴다 — 재실행할 때마다 시작 프레임이 바뀌면 결과를 비교할 수 없다.
 */
export function leadIndexFor(count: number, variantIndex: number): number {
  if (count <= 0) return -1;
  return ((variantIndex % count) + count) % count;
}

/**
 * 재생성 2단계(REFERENCE_SWAP)를 위해 레퍼런스 자산을 선택한다 (§11).
 *
 * variantIndex는 "이 인물의 몇 번째 변주인가"다. image-to-video 제공자는 대표 이미지 1장을
 * 시작 프레임으로 쓰므로, 모든 구간이 같은 사진을 쓰면 1분 영상의 컷 12개가 전부 같은 장소·같은
 * 포즈에서 시작한다. 구간 번호로 대표를 돌려 그것을 막는다(§5.1).
 */
async function pickReferences(
  identityId: string,
  strategy: GenerationJobPayload['strategy'],
  variantIndex = 0,
): Promise<ReferenceAsset[]> {
  const assets = await prisma.identityAsset.findMany({
    where: { identityId, isUsable: true, assetType: { in: ['FACE_IMAGE', 'BODY_IMAGE'] } },
    orderBy: { qualityScore: 'desc' },
  });

  const preferSlots = (strategy?.params?.preferSlots as string[] | undefined) ?? null;
  const excludeKeys = (strategy?.params?.excludeStorageKeys as string[] | undefined) ?? [];

  const ranked = assets
    .filter((a) => !excludeKeys.includes(a.storageKey))
    .sort((a, b) => {
      if (preferSlots) {
        const ai = preferSlots.indexOf(a.captureSlot ?? '');
        const bi = preferSlots.indexOf(b.captureSlot ?? '');
        const aRank = ai === -1 ? 99 : ai;
        const bRank = bi === -1 ? 99 : bi;
        if (aRank !== bRank) return aRank - bRank;
      }
      return Number(b.qualityScore ?? 0) - Number(a.qualityScore ?? 0);
    });

  const picked = ranked.slice(0, 8);
  const leadIndex = leadIndexFor(picked.length, variantIndex);

  // 외부 제공자는 공개 URL만 받으므로 제출 직전에 presigned GET URL을 만든다.
  // 버킷은 비공개를 유지하고, 만료 시간이 붙은 URL만 밖으로 나간다(§15).
  return Promise.all(
    picked.map(async (a, i) => ({
      identityId,
      assetId: a.id,
      storageKey: a.storageKey,
      // 제공자가 직접 내려받으므로 원본이 아니라 축소본을 넘긴다(reference-image.ts)
      signedUrl: await presignReference(a.storageKey).catch(() => null),
      captureSlot: a.captureSlot,
      expression: a.expression,
      quality: a.qualityScore ? Number(a.qualityScore) : null,
      lead: i === leadIndex,
    })),
  );
}

/**
 * 이어 붙일 시작 프레임을 준비한다. 이어 붙이지 않기로 했거나 앞 구간 결과물이 아직 없으면 null이다.
 *
 * 앞 구간이 아직 채택되지 않았는데 이어 붙이라고 하면 이어 붙일 대상 자체가 없다 —
 * 그 경우 조용히 인물 레퍼런스로 시작하고 로그를 남긴다. 순서대로 생성하면 자연히 해결된다.
 */
async function resolveChainStart(
  segment: { id: string; projectId: string; segmentIndex: number; chainFromPrevious: boolean },
  attempt: number,
  traceId: string,
): Promise<{ url: string; storageKey: string; fromSegmentId: string } | null> {
  if (!segment.chainFromPrevious) return null;
  const log = childLogger({ traceId, segmentId: segment.id });

  const siblings = await prisma.segment.findMany({
    where: { projectId: segment.projectId },
    orderBy: { segmentIndex: 'asc' },
    select: { id: true, segmentIndex: true, chainFromPrevious: true, acceptedOutputId: true },
  });
  const index = siblings.findIndex((s) => s.id === segment.id);
  if (!shouldChain(siblings.map((s) => s.chainFromPrevious), index)) {
    log.info({ segmentIndex: segment.segmentIndex },
      `이어 붙이기 사슬이 한도(${MAX_CHAIN_LENGTH})에 닿아 인물 레퍼런스에서 다시 시작한다`);
    return null;
  }

  const previous = siblings[index - 1];
  if (!previous?.acceptedOutputId) {
    log.warn({ previousSegmentIndex: previous?.segmentIndex },
      '앞 구간에 채택된 결과물이 없어 이어 붙일 수 없다 — 인물 레퍼런스로 시작한다');
    return null;
  }

  const output = await prisma.generationOutput.findUnique({ where: { id: previous.acceptedOutputId } });
  if (!output) return null;

  const frame = await buildChainStartFrame({
    previousOutputKey: output.storageKey,
    projectId: segment.projectId,
    segmentId: segment.id,
    attempt,
    traceId,
  });
  return frame ? { ...frame, fromSegmentId: previous.id } : null;
}

async function loadModels(): Promise<ModelDescriptor[]> {
  const rows = await prisma.aiModel.findMany({ where: { status: 'ACTIVE' } });
  return rows.map((m) => ({
    id: m.id, code: m.code, provider: m.provider as ModelDescriptor['provider'],
    endpoint: m.endpoint, capabilities: m.capabilities as never,
    costPerSecond: Number(m.costPerSecond ?? 0), status: m.status,
    metrics: (m.metrics ?? {}) as ModelDescriptor['metrics'],
  }));
}

async function submit(data: GenerationJobPayload) {
  const log = childLogger({ traceId: data.traceId, segmentId: data.segmentId, attempt: data.attempt });

  const segment = await prisma.segment.findUnique({
    where: { id: data.segmentId },
    include: {
      // 위치(slotIndex) 순서가 곧 제공자에 넘기는 인물·레퍼런스 순서다
      project: {
        include: { cast: { orderBy: { slotIndex: 'asc' }, include: { identity: true, profile: true } }, sourceVideos: true },
      },
      scene: true,
    },
  });
  if (!segment) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '세그먼트 없음', data, 404);

  if (segment.status !== 'GENERATING') return { skipped: segment.status };
  const previous = await prisma.generationJob.findUnique({
    where: { segmentId_attempt: { segmentId: segment.id, attempt: data.attempt } },
  });
  // 큐 재전달은 외부 제공자에 두 번 제출하지 않는다. 접수된 작업은 poll reconciler가 맡는다.
  if (previous) return { skipped: previous.status, generationJobId: previous.id };
  const entry = await prisma.spendEntry.findUnique({
    where: { segmentId_attempt: { segmentId: segment.id, attempt: data.attempt } },
  });
  if (entry && entry.status !== 'RESERVED') return { skipped: entry.status };

  const project = segment.project;
  // 조직은 큐의 문자열이 아니라 실제 프로젝트에서 정한다.
  data = { ...data, orgId: project.orgId };
  const config = project.config as {
    resolution?: string; fps?: number; requiredMode?: string; preferredModel?: string; aspectRatio?: string;
    audio?: boolean;
  };
  const resolution = Number((config.resolution ?? '1080p').replace('p', ''));
  const requiredMode = config.requiredMode ?? 'pose-guided';

  // ── §12 Model Router ────────────────────────────────
  const models = await loadModels();
  const routingRuleset = await prisma.routingRuleset.findFirst({ where: { isActive: true } });
  const weights = (routingRuleset?.weights as never) ?? { identity: 0.45, motion: 0.2, quality: 0.15, speed: 0.1, cost: 0.1 };

  // 프로젝트에 지정한 모델. 운영자가 이번 요청에 modelHint를 주면 그쪽이 우선이다.
  // 둘 중 무엇이든 "사용자가 고른 모델"이므로 벗어나지 않는다(§12) — 예전에는 modelHint만
  // 하드 가드 밖에 있어서, 없는 모델을 지정하면 라우터가 조용히 점수 1위 모델을 골라 제출하고 과금됐다.
  const requestedModel = data.modelHint ?? config.preferredModel;
  // 지정 모델이 있으면 재생성의 모델 교체(MODEL_REROUTE)도 따르지 않는다 — 사용자가 고른 모델을 벗어나지 않는다
  const excludeModelIds = requestedModel ? [] : ((data.strategy?.params?.excludeModelIds as string[] | undefined) ?? []);
  let decision: ReturnType<typeof route>;
  try {
    decision = route(models, {
      segmentDurationMs: segment.endMs - segment.startMs,
      castSize: project.cast.length,
      requiredMode,
      resolution,
      weights,
      weightsVersion: routingRuleset?.version ?? 'fallback',
      quota: new StaticQuotaView({}, Number(process.env.GEN_MODEL_QUOTA ?? 4)),
      excludeModelIds,
      preferModelCode: requestedModel,
    });
    if (requestedModel && decision.model.code !== requestedModel) {
      throw new CrezError(
        ErrorCode.GEN_NO_CAPABLE_MODEL,
        `지정 모델 ${requestedModel}이(가) 이 구간 조건을 만족하지 않습니다 — 다른 모델로 대체하지 않습니다`,
        { requestedModel, chosen: decision.model.code, requirements: decision.trace.requirements, rejected: decision.trace.rejected },
        422,
      );
    }
  } catch (e) {
    if (!(e instanceof CrezError)) throw e;
    await failRouting(segment.id, project.id, data, e);
    // 같은 조건이면 몇 번을 다시 해도 같은 결과라 큐 재시도를 하지 않는다
    return { failed: true, code: e.code };
  }

  // ── 생성 파라미터 조립 ──────────────────────────────
  const sourceVideo = project.sourceVideos[0] ?? null;
  const conditioningStrength = Number(data.strategy?.params?.conditioningStrength ?? 0.6);
  const seed = data.strategy?.params?.changeSeed || data.attempt > 1
    ? Math.floor(Math.random() * 2_147_483_647)
    : Number(`${segment.segmentIndex}${data.attempt}`.slice(0, 9));

  const castWithRefs: GenerationRequest['cast'] = [];
  for (const c of project.cast) {
    castWithRefs.push({
      identityId: c.identityId,
      profileId: c.profileId,
      slotIndex: c.slotIndex,
      appearance: c.appearance as Record<string, unknown>,
      // 구간 번호로 대표 사진을 돌린다 — 컷마다 다른 장면에서 출발하도록
      references: await pickReferences(c.identityId, data.strategy, segment.segmentIndex),
    });
  }

  // 컷 없이 이어지는 장면이면 앞 구간의 마지막 프레임에서 출발한다 (§5.1).
  // 세대 손실이 쌓이므로 사슬은 MAX_CHAIN_LENGTH에서 끊고 원본 레퍼런스로 돌아간다.
  const chain = await resolveChainStart(segment, data.attempt, data.traceId);
  if (chain && castWithRefs[0]) {
    castWithRefs[0].references = [
      {
        identityId: castWithRefs[0].identityId,
        assetId: `${CHAIN_ASSET_PREFIX}${chain.fromSegmentId}`,
        storageKey: chain.storageKey,
        signedUrl: chain.url,
        captureSlot: null,
        expression: null,
        quality: null,
        lead: true,
      },
      // 인물 레퍼런스는 뒤에 남겨 둔다 — 이미지를 여러 장 받는 제공자는 신원 근거로 함께 쓴다
      ...castWithRefs[0].references.map((r) => ({ ...r, lead: false })),
    ];
  }

  // 세그먼트에 붙인 이미지. 업로드가 확정되고 삭제되지 않은 것만 쓴다.
  const segmentRefs = await prisma.segmentReference.findMany({
    where: { segmentId: segment.id, active: true, checksum: { not: 'pending' } },
    orderBy: { createdAt: 'asc' },
  });

  // 시작 프레임은 첨부가 아니다 — 첨부로 넘기면 이미지를 1장만 받는 제공자(kling 등)에서
  // 인물 레퍼런스가 그 한 자리를 차지해 통째로 버려진다. 갈라내서 시작 프레임으로 치환한다.
  const pinnedRef = segmentRefs.find((r) => r.kind === 'START_FRAME') ?? null;
  const promptRefs = segmentRefs.filter((r) => r.kind !== 'START_FRAME');

  if (pinnedRef && castWithRefs[0]) {
    // 사람이 "이 이미지로 시작하라"고 지정한 것이다. 주소를 만들지 못했을 때 조용히 인물 사진으로
    // 되돌리면, 지정한 의상·구도와 다른 영상이 돈만 쓰고 나온다. 그래서 여기서는 실패시킨다.
    const url = await presignedGet(pinnedRef.storageKey).catch((e) => {
      log.error({ err: String(e), referenceId: pinnedRef.id }, '지정한 시작 프레임의 주소를 만들지 못했다');
      return null;
    });
    if (!url) {
      await failRouting(segment.id, project.id, data, new CrezError(
        ErrorCode.GEN_PROVIDER_ERROR,
        '지정한 시작 프레임을 읽을 수 없습니다 — 다시 업로드한 뒤 실행하세요',
        { referenceId: pinnedRef.id, storageKey: pinnedRef.storageKey }, 422,
      ));
      return { failed: true, code: ErrorCode.GEN_PROVIDER_ERROR };
    }
    if (chain) {
      log.info({ referenceId: pinnedRef.id },
        '사람이 지정한 시작 프레임이 이어 붙이기보다 우선한다 — 이어 붙인 프레임은 쓰지 않는다');
    }
    castWithRefs[0].references = [
      {
        identityId: castWithRefs[0].identityId,
        assetId: `${PINNED_ASSET_PREFIX}${pinnedRef.id}`,
        storageKey: pinnedRef.storageKey,
        signedUrl: url,
        captureSlot: null,
        expression: null,
        quality: null,
        lead: true,
      },
      // 인물 레퍼런스는 뒤에 남겨 둔다 — 이미지를 여러 장 받는 제공자는 신원 근거로 함께 쓴다
      ...castWithRefs[0].references.map((r) => ({ ...r, lead: false })),
    ];
    // 구간별 레퍼런스 회전(§5.1)은 이 구간에 적용되지 않는다. 여러 구간에 같은 프레임을 지정하면
    // 모든 컷이 같은 장면으로 시작하므로, 나중에 원인을 찾을 수 있게 남긴다.
    log.info({ referenceId: pinnedRef.id, segmentIndex: segment.segmentIndex },
      '사람이 지정한 시작 프레임으로 시작한다 — 이 구간은 레퍼런스 회전을 쓰지 않는다');
  }

  const attachments: PromptAttachment[] = await Promise.all(
    promptRefs.map(async (r) => ({
      referenceId: r.id,
      kind: r.kind as PromptAttachment['kind'],
      slotIndex: r.slotIndex,
      storageKey: r.storageKey,
      signedUrl: await presignedGet(r.storageKey).catch(() => null),
    })),
  );

  const generationJobId = randomUUID();
  const outputKey = storageKey.segmentOutput(project.id, segment.id, data.attempt);

  // 운영자 프롬프트를 먼저 점검한다. 시작 이미지와 충돌하는 요구(다른 장소·다른 인물·외모 변경)는
  // 모델이 장면 전환으로 풀어버려 인물이 교체된다 — 막지는 않고 이력에 남겨 원인을 설명 가능하게 한다.
  const operatorPrompt = segment.prompt ?? segment.scene?.prompt ?? null;
  const promptRisks = inspectPrompt(operatorPrompt, {
    mode: requiredMode as string,
    castCount: project.cast.length,
  });
  if (promptRisks.length > 0) {
    log.warn(
      { segmentId: segment.id, risks: promptRisks.map((r) => ({ kind: r.kind, term: r.term })) },
      `프롬프트가 신원 유지와 충돌한다 — ${summarizeRisks(promptRisks)}`,
    );
  }

  const request: GenerationRequest = {
    traceId: data.traceId,
    segmentId: segment.id,
    attempt: data.attempt,
    durationMs: segment.endMs - segment.startMs,
    fps: config.fps ?? 30,
    resolution,
    // 프로젝트 설정이 없으면 16:9 (§6.3). 비율을 받지 않는 제공자는 어댑터가 경고를 남긴다.
    aspectRatio: config.aspectRatio === '9:16' ? '9:16' : '16:9',
    // 소리는 기본으로 켠다 — 설정이 없는 예전 프로젝트도 음악이 붙는다. 끄려면 명시적으로 false.
    audio: config.audio !== false,
    mode: requiredMode as never,
    // 세그먼트 프롬프트가 우선이고 비어 있으면 씬 프롬프트를 쓴다.
    // 제공자에는 신원 고정 문구를 붙여서 보낸다 — 붙이지 않으면 시작 이미지의 인물이
    // 중간에 다른 사람으로 교체된다(prompt-identity.ts에 실측 근거).
    prompt: withIdentityAnchor(operatorPrompt),
    seed,
    conditioningStrength,
    cast: castWithRefs,
    attachments,
    sourceVideoKey: sourceVideo?.storageKey ?? null,
    sourceTracksKey: sourceVideo?.tracksKey ?? null,
    outputKey,
  };

  const provider = providerRegistry.resolve(decision.model);
  // 제공자마다 받을 수 있는 이미지 수가 다르다. 실제로 넘긴 이미지와 빠진 첨부를 기록한다(URL은 만료되므로 제외).
  const imagePlan = provider.planImages(request);

  // 외부 제공자는 공개 URL로만 이미지를 받아간다(§12.1). 로컬 주소를 그대로 보내면 제공자 쪽에서
  // "Generation failed"로 끝나면서 시도 횟수와 크레딧만 사라진다 — 보내기 전에 막는다.
  const localImage = imagePlan.images.find((i) => isLocalUrl(i.url));
  if (localImage && !decision.model.code.startsWith('mock')) {
    await failRouting(segment.id, project.id, data, new CrezError(
      ErrorCode.GEN_PROVIDER_ERROR,
      '레퍼런스 이미지 주소가 외부에서 열리지 않습니다 — S3_PUBLIC_ENDPOINT를 공개 주소로 설정한 뒤 다시 실행하세요',
      { host: hostOf(localImage.url), model: decision.model.code },
      422,
    ));
    return { failed: true, code: ErrorCode.GEN_PROVIDER_ERROR };
  }

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      await lockOrganizationSpend(tx, project.orgId);
      const current = await tx.segment.findUnique({ where: { id: segment.id } });
      if (!current || current.status !== 'GENERATING') return null;
      const previous = await tx.generationJob.findUnique({
        where: { segmentId_attempt: { segmentId: segment.id, attempt: data.attempt } },
      });
      if (previous) return null;
      const reservation = await tx.spendEntry.findUnique({
        where: { segmentId_attempt: { segmentId: segment.id, attempt: data.attempt } },
      });
      if (reservation && reservation.status !== 'RESERVED') return null;
      const free = decision.model.code.startsWith('mock') || (decision.model.capabilities as { billable?: boolean }).billable === false;
      await reserveSpend(tx, project.orgId, [{
        projectId: project.id, segmentId: segment.id, attempt: data.attempt,
        amountCredits: free ? 0 : provider.estimateCost(request, decision.model),
      }]);
      await tx.spendEntry.update({
        where: { segmentId_attempt: { segmentId: segment.id, attempt: data.attempt } },
        data: { status: 'SUBMITTED', createdAt: new Date() },
      });
      const created = await tx.generationJob.create({
        data: {
          id: generationJobId,
          segmentId: segment.id,
          attempt: data.attempt,
          modelId: decision.model.id,
          routingTrace: decision.trace as never,
          params: {
            traceId: data.traceId, mode: request.mode, durationMs: request.durationMs, fps: request.fps,
            resolution: request.resolution, aspectRatio: request.aspectRatio, audio: request.audio,
            // 제공자에 실제로 보낸 프롬프트와 운영자가 쓴 원문을 함께 남긴다 — 결과를 나중에 설명하려면 둘 다 필요하다
            prompt: request.prompt, operatorPrompt,
            promptRisks: promptRisks.map((r) => ({ kind: r.kind, term: r.term, message: r.message })),
            conditioningStrength,
            strategy: data.strategy ?? null,
            references: castWithRefs.map((c) => ({
              identityId: c.identityId,
              // 이어 붙인 시작 프레임과 사람이 지정한 시작 프레임은 identity_asset 행이 아니다 —
              // 여기 섞으면 결과 조회 때 자산을 UUID로 되찾는 과정에서 통째로 실패한다(2026-09-17 실측).
              assetIds: c.references.map((r) => r.assetId).filter((id) => !isSyntheticAsset(id)),
            })),
            // 이어 붙인 사실은 따로 남긴다 — 나중에 "이 컷은 무엇에서 이어졌나"를 설명할 수 있어야 한다
            chainStart: chain ? { fromSegmentId: chain.fromSegmentId, storageKey: chain.storageKey } : null,
            // 지정한 시작 프레임도 마찬가지다. 첨부가 아니라 치환이라 droppedReferenceIds에 잡히지 않으므로,
            // 이 기록이 없으면 "지정한 이미지가 쓰였는가"를 화면에서 답할 방법이 없다.
            pinnedStart: pinnedRef ? { referenceId: pinnedRef.id, storageKey: pinnedRef.storageKey } : null,
            attachments: attachments.map((a) => ({ referenceId: a.referenceId, kind: a.kind, slotIndex: a.slotIndex })),
            imagePlan: {
              images: imagePlan.images.map(({ url: _url, ...rest }) => rest),
              droppedReferenceIds: imagePlan.droppedReferenceIds,
            },
          } as never,
          seed: BigInt(seed),
          status: 'QUEUED',
          startedAt: new Date(),
        },
      });
      if (data.regenerationTaskId) {
        await tx.regenerationTask.update({
          where: { id: data.regenerationTaskId }, data: { resultJobId: created.id },
        });
      }
      return created;
    });
  } catch (error) {
    if (error instanceof CrezError) {
      await failRouting(segment.id, project.id, data, error);
      return { failed: true, code: error.code };
    }
    throw error;
  }
  if (!created) return { skipped: 'already submitted or cancelled' };

  let providerAccepted = false;
  try {
    const result = await provider.submit(request, decision.model);
    providerAccepted = true;
    await prisma.generationJob.update({
      where: { id: created.id },
      data: { status: 'SUBMITTED', providerJobId: result.providerJobId },
    });

    await audit({
      orgId: data.orgId, action: 'PROJECT_GENERATED', projectId: project.id,
      payload: {
        event: 'JOB_SUBMITTED', segmentId: segment.id, attempt: data.attempt,
        modelCode: decision.model.code, routingTrace: decision.trace,
        identities: project.cast.map((c) => ({ identityId: c.identityId, profileVersion: c.profile.version })),
        seed, conditioningStrength,
      },
      traceId: data.traceId,
    });

    await emit({
      type: 'SEGMENT_STATUS', projectId: project.id, segmentId: segment.id,
      payload: { status: 'GENERATING', attempt: data.attempt, model: decision.model.code },
      traceId: data.traceId,
    });

    // 지연 폴링 시작 (§8)
    await queues.generation.add(
      JOB_NAME.GENERATION_POLL,
      {
        traceId: data.traceId, orgId: data.orgId, projectId: project.id, segmentId: segment.id,
        generationJobId: created.id, providerJobId: result.providerJobId, pollCount: 0,
      },
      { delay: 2000 },
    );

    log.info({ model: decision.model.code, providerJobId: result.providerJobId }, 'generation submitted');
    return { generationJobId: created.id, model: decision.model.code, providerJobId: result.providerJobId };
  } catch (e) {
    if (providerAccepted) throw e;
    const code = e instanceof CrezError ? e.code : ErrorCode.GEN_PROVIDER_ERROR;
    await failJob(created.id, segment.id, project.id, data, code, e);
    // 콘텐츠 정책 거부는 재시도 대상이 아니다 (§8)
    if (code === ErrorCode.GEN_CONTENT_POLICY) return { failed: true, code };
    throw e;
  }
}

/** 제출 준비가 큐의 마지막 재시도에서도 실패하면 미제출 예약을 해제한다. */
export function isLastAttempt(job: { attemptsMade?: number; opts?: { attempts?: number } }): boolean {
  const made = job.attemptsMade ?? 0;
  const allowed = job.opts?.attempts ?? 1;
  return made + 1 >= allowed;
}

/** Prisma 유일 제약 위반 판별. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

async function poll(
  data: GenerationPollJob & { projectId: string; segmentId: string; orgId: string },
  lastAttempt = true,
) {
  const log = childLogger({ traceId: data.traceId, generationJobId: data.generationJobId });

  const genJob = await prisma.generationJob.findUnique({
    where: { id: data.generationJobId }, include: { model: true, segment: true },
  });
  if (!genJob) return { skipped: 'job gone' };
  if (['FAILED', 'CANCELLED'].includes(genJob.status)) return { skipped: genJob.status };
  const saved = await prisma.generationOutput.findUnique({ where: { jobId: genJob.id } });
  if (saved) return finalizeGeneration(genJob.id, data);

  const descriptor: ModelDescriptor = {
    id: genJob.model.id, code: genJob.model.code, provider: genJob.model.provider as never,
    endpoint: genJob.model.endpoint, capabilities: genJob.model.capabilities as never,
    costPerSecond: Number(genJob.model.costPerSecond ?? 0), status: genJob.model.status,
    metrics: (genJob.model.metrics ?? {}) as never,
  };
  const provider = providerRegistry.resolve(descriptor);
  const state = await provider.poll(data.providerJobId, descriptor);

  if (state.state === 'RUNNING') {
    if (genJob.status !== 'RUNNING') {
      await prisma.generationJob.update({ where: { id: genJob.id }, data: { status: 'RUNNING' } });
    }
    await emit({
      type: 'JOB_PROGRESS', projectId: data.projectId, segmentId: data.segmentId,
      payload: { stage: 'GENERATION', progress: state.progress, attempt: genJob.attempt }, traceId: data.traceId,
    });

    const pollCount = (data.pollCount ?? 0) + 1;
    const maxPolls = Number(process.env.GEN_MAX_POLLS ?? 720);
    if (pollCount > maxPolls) {
      await failJob(genJob.id, data.segmentId, data.projectId, data, ErrorCode.GEN_PROVIDER_ERROR, 'poll timeout');
      throw new CrezError(ErrorCode.GEN_PROVIDER_ERROR, '생성 폴링 시간 초과', { pollCount }, 504);
    }
    await queues.generation.add(
      JOB_NAME.GENERATION_POLL,
      { ...data, pollCount },
      { delay: state.nextPollMs ?? 5000 },
    );
    return { state: 'RUNNING', progress: state.progress };
  }

  if (state.state === 'FAILED' || state.state === 'CANCELLED') {
    const code = state.errorCode === ErrorCode.GEN_CONTENT_POLICY
      ? ErrorCode.GEN_CONTENT_POLICY : ErrorCode.GEN_PROVIDER_ERROR;
    // 제공자가 결과를 알려 준 실패다 — 원장에서 실지출을 뺀다.
    await failJob(genJob.id, data.segmentId, data.projectId, data, code, state.errorDetail, true);
    return { state: state.state, code };
  }

  // 결과를 먼저 수집하고 출력·성공 상태·정산을 한 트랜잭션으로 확정한다.
  let result;
  try {
    const request = await rebuildRequest(genJob.id);
    const fetched = await provider.fetchResult(data.providerJobId, request, descriptor);
    result = await materializeOutput(fetched, request.outputKey, {
      isMock: provider.code === 'mock', traceId: data.traceId,
    });
  } catch (e) {
    log.warn({ err: String(e), lastAttempt }, '결과물 수집 실패 — 폴링 복구 대상으로 남긴다');
    throw e;
  }
  // DB/QC 큐 장애는 유료 결과를 FAILED로 확정하지 않는다. 미완료 상태를 reconciler가 복구한다.
  return finalizeGeneration(genJob.id, data, result);
}

/**
 * fetchResult에 필요한 요청 정보를 job 레코드에서 복원한다.
 * 캐스트와 레퍼런스도 함께 복원한다 — 제공자에 따라 결과 조회 시점에 필요하고,
 * 비어 있으면 실제 API 연동에서 조용히 깨진다.
 */
async function rebuildRequest(generationJobId: string): Promise<GenerationRequest> {
  const j = await prisma.generationJob.findUniqueOrThrow({
    where: { id: generationJobId },
    include: { segment: { include: { project: { include: { cast: { orderBy: { slotIndex: 'asc' } } } } } } },
  });
  const params = j.params as Record<string, unknown>;
  const savedRefs = (params.references as Array<{ identityId: string; assetIds: string[] }> | undefined) ?? [];

  const cast = await Promise.all(
    j.segment.project.cast.map(async (c) => {
      // 과거 기록에 섞여 들어간 비-UUID(이어 붙이기·지정 시작 프레임의 가짜 id)도 걸러 낸다
      const assetIds = (savedRefs.find((r) => r.identityId === c.identityId)?.assetIds ?? [])
        .filter((id) => !isSyntheticAsset(id));
      const assets = assetIds.length
        ? await prisma.identityAsset.findMany({ where: { id: { in: assetIds } } })
        : [];
      return {
        identityId: c.identityId,
        profileId: c.profileId,
        slotIndex: c.slotIndex,
        appearance: c.appearance as Record<string, unknown>,
        references: await Promise.all(
          assets.map(async (a) => ({
            identityId: c.identityId,
            assetId: a.id,
            storageKey: a.storageKey,
            signedUrl: await presignedGet(a.storageKey).catch(() => null),
            captureSlot: a.captureSlot,
            expression: a.expression,
            quality: a.qualityScore ? Number(a.qualityScore) : null,
          })),
        ),
      };
    }),
  );

  return {
    traceId: '', segmentId: j.segmentId, attempt: j.attempt,
    durationMs: Number(params.durationMs ?? j.segment.endMs - j.segment.startMs),
    fps: Number(params.fps ?? 30),
    resolution: Number(params.resolution ?? 1080),
    mode: (params.mode as never) ?? 'pose-guided',
    aspectRatio: params.aspectRatio === '9:16' ? '9:16' : '16:9',
    audio: params.audio !== false,
    prompt: (params.prompt as string) ?? null,
    seed: j.seed ? Number(j.seed) : null,
    conditioningStrength: Number(params.conditioningStrength ?? 0.6),
    cast,
    // 결과 조회에는 참고 이미지가 필요 없다 — 제출 때 쓴 목록은 params.attachments에 남아 있다
    attachments: [],
    sourceVideoKey: null, sourceTracksKey: null,
    outputKey: storageKey.segmentOutput(j.segment.projectId, j.segmentId, j.attempt),
  };
}

/**
 * 모델 라우팅 단계 실패 — generation job을 만들기 전이다.
 * api가 제출 전에 GENERATING과 attemptCount를 올려 두므로, 되돌리지 않으면 세그먼트가 GENERATING에 멈추고
 * 제출되지도 않은 시도가 한도를 깎는다. FAILED로 두어 원인을 고친 뒤 다시 생성할 수 있게 한다.
 */
async function failRouting(
  segmentId: string, projectId: string,
  data: { traceId: string; orgId: string; attempt: number }, err: CrezError,
) {
  await prisma.$transaction(async (tx) => {
    await lockOrganizationSpend(tx, data.orgId);
    await tx.spendEntry.updateMany({
      where: { orgId: data.orgId, segmentId, attempt: data.attempt, status: 'RESERVED' },
      data: { status: 'RELEASED' },
    });
  });
  // 제출 전에 실패했으므로 한도 카운터를 되돌린다. job 시도 번호(data.attempt)와 한도 카운터는 다른 값이다.
  const current = await prisma.segment.findUnique({ where: { id: segmentId }, select: { attemptCount: true } });
  await prisma.segment.update({
    where: { id: segmentId },
    data: { status: 'FAILED', attemptCount: Math.max(0, (current?.attemptCount ?? 1) - 1) },
  });
  // 아무것도 만들지 못한 프로젝트가 RUNNING에 남으면 설정을 고칠 수 없다 — 생성 전(READY)으로 되돌린다
  const [inFlight, produced] = await Promise.all([
    prisma.segment.count({ where: { projectId, status: { in: ['GENERATING', 'QC'] } } }),
    prisma.generationJob.count({ where: { segment: { projectId }, status: { notIn: ['CANCELLED', 'FAILED'] } } }),
  ]);
  if (inFlight === 0 && produced === 0) {
    await prisma.project.updateMany({ where: { id: projectId, status: 'RUNNING' }, data: { status: 'READY' } });
  }
  const detail = { message: err.message, detail: err.detail ?? null };
  await emit({
    type: 'ERROR', projectId, segmentId,
    payload: { code: err.code, ...detail, segmentStatus: 'FAILED' },
    traceId: data.traceId,
  });
  await audit({
    orgId: data.orgId, action: 'PROJECT_GENERATED', projectId,
    payload: { event: 'ROUTING_FAILED', segmentId, attempt: data.attempt, code: err.code, ...detail },
    traceId: data.traceId,
  });
  childLogger({ traceId: data.traceId, segmentId }).warn({ code: err.code, ...detail }, 'generation routing failed');
}

/** 제공자가 받아갈 수 없는 주소인지 — 로컬 개발 주소로 제출하면 생성이 실패한다 (§12.1) */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'minio', 'host.docker.internal']);
function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url.slice(0, 40); }
}
function isLocalUrl(url: string): boolean {
  const host = hostOf(url);
  return LOCAL_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal');
}

interface CancelJob {
  traceId: string; orgId: string; projectId: string; segmentId: string;
  generationJobId: string; providerJobId: string;
}

/**
 * 제출한 생성을 제공자에서 취소한다 (§12.1).
 *
 * 로컬 job을 CANCELLED로 바꾸는 것만으로는 외부 생성이 멈추지 않는다 — 계속 만들어지고 과금된다.
 * 제공자가 거부할 수도 있다(Higgsfield는 이미 진행 중인 요청의 취소를 400으로 거절한다).
 * 그 경우 작업을 실패로 만들지 않고, 과금이 계속될 수 있다는 사실을 기록에 남긴다.
 */
async function cancelSubmission(data: CancelJob) {
  const log = childLogger({ traceId: data.traceId, segmentId: data.segmentId });
  const job = await prisma.generationJob.findUnique({
    where: { id: data.generationJobId }, include: { model: true },
  });
  if (!job) return { skipped: 'job not found' };

  const m = job.model;
  const descriptor: ModelDescriptor = {
    id: m.id, code: m.code, provider: m.provider as ModelDescriptor['provider'],
    endpoint: m.endpoint, capabilities: m.capabilities as never,
    costPerSecond: Number(m.costPerSecond ?? 0), status: m.status, metrics: m.metrics as never,
  };

  try {
    await providerRegistry.resolve(descriptor).cancel(data.providerJobId, descriptor);
    await prisma.generationJob.update({
      where: { id: job.id },
      data: { errorDetail: { providerCancel: 'REQUESTED', providerJobId: data.providerJobId } as never },
    });
    log.info({ providerJobId: data.providerJobId, model: m.code }, '제공자 취소 요청 완료');
    return { cancelled: true };
  } catch (e) {
    const detail = e instanceof CrezError
      ? { code: e.code, message: e.message }
      : { code: null, message: String(e) };
    await prisma.generationJob.update({
      where: { id: job.id },
      data: { errorDetail: { providerCancel: 'REFUSED', providerJobId: data.providerJobId, ...detail } as never },
    });
    await audit({
      orgId: data.orgId, action: 'PROJECT_GENERATED', projectId: data.projectId,
      payload: {
        event: 'PROVIDER_CANCEL_REFUSED', segmentId: data.segmentId,
        providerJobId: data.providerJobId, model: m.code, ...detail,
      },
      traceId: data.traceId,
    });
    log.warn({ providerJobId: data.providerJobId, ...detail }, '제공자 취소 거부 — 과금이 계속될 수 있다');
    return { cancelled: false, ...detail };
  }
}

/**
 * 생성 job 실패 기록.
 *
 * providerConfirmed는 "제공자가 실패를 확정했다"는 뜻이다. 그 경우에만 원장을 FAILED로 옮겨
 * 실지출(실패 제외) 한도에서 뺀다 — 제공자는 실패한 요청을 과금하지 않는다고 밝히고 있다.
 * 제출 중 오류나 폴링 timeout은 접수됐을 수 있으므로 SUBMITTED로 남겨 실지출에 계속 포함한다.
 */
async function failJob(
  generationJobId: string, segmentId: string, projectId: string,
  data: { traceId: string; orgId: string; attempt?: number }, code: string, detail: unknown,
  providerConfirmed = false,
) {
  const failed = await prisma.generationJob.update({
    where: { id: generationJobId },
    data: {
      status: 'FAILED', finishedAt: new Date(),
      errorCode: code, errorDetail: { detail: String(detail) } as never,
    },
  });

  if (providerConfirmed) {
    await prisma.$transaction(async (tx) => {
      await lockOrganizationSpend(tx, data.orgId);
      await markSpendFailed(tx, data.orgId, segmentId, failed.attempt);
    });
  }

  const segment = await prisma.segment.findUnique({ where: { id: segmentId } });
  // 다시 보내도 결과가 같은 코드 — 콘텐츠 정책 거부, 모델 접근 불가, 크레딧 부족.
  // 원인을 고치기 전에는 재시도가 의미 없고, 유료 제공자에서는 헛돈만 나간다.
  const terminal: string[] = [ErrorCode.GEN_CONTENT_POLICY, ErrorCode.GEN_NO_CAPABLE_MODEL, ErrorCode.GEN_QUOTA_EXCEEDED];
  // 재시도 여지가 남았으면 PENDING으로 되돌려 다음 생성 요청을 받을 수 있게 한다 (§5.1)
  const exhausted = (segment?.attemptCount ?? 0) >= MAX_GENERATION_ATTEMPT || terminal.includes(code);
  await prisma.segment.update({
    where: { id: segmentId }, data: { status: exhausted ? 'FAILED' : 'PENDING' },
  });

  await emit({
    type: 'ERROR', projectId, segmentId,
    payload: { code, detail: String(detail), segmentStatus: exhausted ? 'FAILED' : 'PENDING' },
    traceId: data.traceId,
  });
  await audit({
    orgId: data.orgId, action: 'PROJECT_GENERATED', projectId,
    payload: { event: 'JOB_FAILED', segmentId, code, detail: String(detail) }, traceId: data.traceId,
  });
}

/**
 * §8 reconciler — 워커 재시작으로 폴링이 유실된 SUBMITTED/RUNNING job을 주기적으로 재투입한다.
 */
export async function reconcileSubmittedJobs(): Promise<number> {
  const staleAfterMs = Number(process.env.GEN_RECONCILE_STALE_MS ?? 120000);
  const stale = await prisma.generationJob.findMany({
    where: {
      status: { in: ['SUBMITTED', 'RUNNING'] },
      startedAt: { lt: new Date(Date.now() - staleAfterMs) },
      providerJobId: { not: null },
    },
    include: { segment: { include: { project: true } } },
    take: 100,
  });

  for (const j of stale) {
    await queues.generation.add(
      JOB_NAME.GENERATION_POLL,
      {
        traceId: (j.params as { traceId?: string }).traceId ?? `reconcile-${j.id}`,
        orgId: j.segment.project.orgId, projectId: j.segment.projectId,
        segmentId: j.segmentId, generationJobId: j.id,
        providerJobId: j.providerJobId as string, pollCount: 0,
      },
      { delay: 1000, jobId: `reconcile-${j.id}-${Date.now()}` },
    );
  }
  const pendingQc = await prisma.generationOutput.findMany({
    where: { qcQueuedAt: null, job: { status: 'SUCCEEDED' } },
    include: { job: { include: { segment: { include: { project: true } } } } },
    orderBy: { createdAt: 'asc' }, take: 100,
  });
  for (const output of pendingQc) {
    const j = output.job;
    try {
      await finalizeGeneration(j.id, {
        traceId: (j.params as { traceId?: string }).traceId ?? `reconcile-${j.id}`,
        orgId: j.segment.project.orgId, projectId: j.segment.projectId, segmentId: j.segmentId,
      });
    } catch (error) {
      childLogger({ component: 'reconciler' }).warn({ err: String(error), outputId: output.id }, 'QC 인계 재시도 실패');
    }
  }
  const pendingDispatch = await prisma.spendEntry.findMany({
    where: { status: 'RESERVED', dispatchedAt: null, dispatch: { not: Prisma.DbNull } }, orderBy: { createdAt: 'asc' }, take: 100,
  });
  for (const entry of pendingDispatch) {
    if (!entry.dispatch) continue;
    const dispatch = entry.dispatch as { payload: GenerationJobPayload; priority: number };
    try {
      await queues.generation.add(JOB_NAME.GENERATION_SUBMIT, dispatch.payload, {
        jobId: generationDispatchId(entry.segmentId, entry.attempt), priority: dispatch.priority,
        attempts: QUEUE_POLICY[QUEUE.GENERATION].attempts,
        backoff: { type: 'exponential', delay: QUEUE_POLICY[QUEUE.GENERATION].backoffMs },
        removeOnComplete: false, removeOnFail: false,
      });
      await prisma.spendEntry.update({ where: { id: entry.id }, data: { dispatchedAt: new Date() } });
    } catch (error) {
      childLogger({ component: 'reconciler' }).warn({ err: String(error), entryId: entry.id }, '생성 큐 인계 재시도 실패');
    }
  }
  if (stale.length > 0) childLogger({ component: 'reconciler' }).info({ count: stale.length }, 'requeued stale polls');
  return stale.length + pendingQc.length + pendingDispatch.filter((e) => e.dispatch).length;
}
