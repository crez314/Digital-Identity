import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { getProfileCentroids, prisma } from '@crez/db';
import {
  providerRegistry, route, StaticQuotaView,
  type GenerationRequest, type ModelDescriptor, type ReferenceAsset,
} from '@crez/providers';
import {
  CrezError, ErrorCode, MAX_GENERATION_ATTEMPT, QUEUE, childLogger, storageKey,
} from '@crez/shared';
import { JOB_NAME, type GenerationJobPayload, type GenerationPollJob } from '@crez/contracts';
import { emit } from '../lib/events';
import { audit } from '../lib/audit';
import { queues } from '../lib/queues';
import { materializeOutput } from '../lib/materialize';
import { presignedGet } from '../lib/media-io';

/**
 * generation 큐 (§8, §12).
 * 라우팅 → 제출 → provider_job_id 저장 → 지연 폴링.
 * 워커 재시작으로 폴링이 유실되지 않도록 SUBMITTED 상태를 reconciler가 주기 스캔한다.
 */
export async function generationProcessor(job: Job): Promise<unknown> {
  switch (job.name) {
    case JOB_NAME.GENERATION_SUBMIT:
      return submit(job.data as GenerationJobPayload);
    case JOB_NAME.GENERATION_POLL:
      return poll(job.data as GenerationPollJob & { projectId: string; segmentId: string; orgId: string });
    default:
      throw new Error(`unknown generation job: ${job.name}`);
  }
}

/** 재생성 2단계(REFERENCE_SWAP)를 위해 레퍼런스 자산을 선택한다 (§11) */
async function pickReferences(
  identityId: string,
  strategy: GenerationJobPayload['strategy'],
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

  // 외부 제공자는 공개 URL만 받으므로 제출 직전에 presigned GET URL을 만든다.
  // 버킷은 비공개를 유지하고, 만료 시간이 붙은 URL만 밖으로 나간다(§15).
  return Promise.all(
    ranked.slice(0, 8).map(async (a) => ({
      identityId,
      assetId: a.id,
      storageKey: a.storageKey,
      signedUrl: await presignedGet(a.storageKey).catch(() => null),
      captureSlot: a.captureSlot,
      expression: a.expression,
      quality: a.qualityScore ? Number(a.qualityScore) : null,
    })),
  );
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
      project: { include: { cast: { include: { identity: true, profile: true } }, sourceVideos: true } },
      scene: true,
    },
  });
  if (!segment) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '세그먼트 없음', data, 404);

  const project = segment.project;
  const config = project.config as { resolution?: string; fps?: number; requiredMode?: string };
  const resolution = Number((config.resolution ?? '1080p').replace('p', ''));
  const requiredMode = config.requiredMode ?? 'pose-guided';

  // ── §12 Model Router ────────────────────────────────
  const models = await loadModels();
  const routingRuleset = await prisma.routingRuleset.findFirst({ where: { isActive: true } });
  const weights = (routingRuleset?.weights as never) ?? { identity: 0.45, motion: 0.2, quality: 0.15, speed: 0.1, cost: 0.1 };

  const excludeModelIds = (data.strategy?.params?.excludeModelIds as string[] | undefined) ?? [];
  const decision = route(models, {
    segmentDurationMs: segment.endMs - segment.startMs,
    castSize: project.cast.length,
    requiredMode,
    resolution,
    weights,
    weightsVersion: routingRuleset?.version ?? 'fallback',
    quota: new StaticQuotaView({}, Number(process.env.GEN_MODEL_QUOTA ?? 4)),
    excludeModelIds,
    preferModelCode: data.modelHint,
  });

  // ── 생성 파라미터 조립 ──────────────────────────────
  const sourceVideo = project.sourceVideos[0] ?? null;
  const conditioningStrength = Number(data.strategy?.params?.conditioningStrength ?? 0.6);
  const seed = data.strategy?.params?.changeSeed || data.attempt > 1
    ? Math.floor(Math.random() * 2_147_483_647)
    : Number(`${segment.segmentIndex}${data.attempt}`.slice(0, 9));

  const castWithRefs = [];
  for (const c of project.cast) {
    castWithRefs.push({
      identityId: c.identityId,
      profileId: c.profileId,
      slotIndex: c.slotIndex,
      appearance: c.appearance as Record<string, unknown>,
      references: await pickReferences(c.identityId, data.strategy),
    });
  }

  const generationJobId = randomUUID();
  const outputKey = storageKey.segmentOutput(project.id, segment.id, data.attempt);

  const request: GenerationRequest = {
    traceId: data.traceId,
    segmentId: segment.id,
    attempt: data.attempt,
    durationMs: segment.endMs - segment.startMs,
    fps: config.fps ?? 30,
    resolution,
    mode: requiredMode as never,
    prompt: segment.scene?.prompt ?? null,
    seed,
    conditioningStrength,
    cast: castWithRefs,
    sourceVideoKey: sourceVideo?.storageKey ?? null,
    sourceTracksKey: sourceVideo?.tracksKey ?? null,
    outputKey,
  };

  const provider = providerRegistry.resolve(decision.model);

  const created = await prisma.generationJob.create({
    data: {
      id: generationJobId,
      segmentId: segment.id,
      attempt: data.attempt,
      modelId: decision.model.id,
      routingTrace: decision.trace as never,
      params: {
        mode: request.mode, durationMs: request.durationMs, fps: request.fps,
        resolution: request.resolution, prompt: request.prompt,
        conditioningStrength,
        strategy: data.strategy ?? null,
        references: castWithRefs.map((c) => ({
          identityId: c.identityId, assetIds: c.references.map((r) => r.assetId),
        })),
      } as never,
      seed: BigInt(seed),
      status: 'QUEUED',
      startedAt: new Date(),
    },
  });

  // 재생성 이력과 이번 job을 연결한다 (§11)
  if (data.regenerationTaskId) {
    await prisma.regenerationTask.update({
      where: { id: data.regenerationTaskId }, data: { resultJobId: created.id },
    });
  }

  try {
    const result = await provider.submit(request, decision.model);
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
    const code = e instanceof CrezError ? e.code : ErrorCode.GEN_PROVIDER_ERROR;
    await failJob(created.id, segment.id, project.id, data, code, e);
    // 콘텐츠 정책 거부는 재시도 대상이 아니다 (§8)
    if (code === ErrorCode.GEN_CONTENT_POLICY) return { failed: true, code };
    throw e;
  }
}

async function poll(data: GenerationPollJob & { projectId: string; segmentId: string; orgId: string }) {
  const log = childLogger({ traceId: data.traceId, generationJobId: data.generationJobId });

  const genJob = await prisma.generationJob.findUnique({
    where: { id: data.generationJobId }, include: { model: true, segment: true },
  });
  if (!genJob) return { skipped: 'job gone' };
  if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(genJob.status)) return { skipped: genJob.status };

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
    await failJob(genJob.id, data.segmentId, data.projectId, data, code, state.errorDetail);
    return { state: state.state, code };
  }

  // ── SUCCEEDED ──────────────────────────────────────
  const request = await rebuildRequest(genJob.id);
  const fetched = await provider.fetchResult(data.providerJobId, request, descriptor);
  // 어댑터가 알려준 위치의 결과물을 §15 스토리지 레이아웃의 키로 실체화한다.
  const result = await materializeOutput(fetched, request.outputKey, {
    isMock: provider.code === 'mock',
    traceId: data.traceId,
  });

  const output = await prisma.generationOutput.create({
    data: {
      jobId: genJob.id, storageKey: result.storageKey,
      durationMs: result.durationMs, fps: result.fps, width: result.width, height: result.height,
    },
  });
  await prisma.generationJob.update({
    where: { id: genJob.id },
    data: { status: 'SUCCEEDED', finishedAt: new Date(), costAmount: result.costAmount },
  });
  await prisma.segment.update({ where: { id: data.segmentId }, data: { status: 'QC' } });

  await emit({
    type: 'SEGMENT_STATUS', projectId: data.projectId, segmentId: data.segmentId,
    payload: { status: 'QC', attempt: genJob.attempt }, traceId: data.traceId,
  });

  // QC 큐로 넘긴다 (§8)
  await queues.qc.add(JOB_NAME.QC_RUN, {
    traceId: data.traceId, orgId: data.orgId, projectId: data.projectId,
    segmentId: data.segmentId, outputId: output.id, attempt: genJob.attempt,
  });

  log.info({ outputId: output.id, cost: result.costAmount }, 'generation succeeded → QC queued');
  return { state: 'SUCCEEDED', outputId: output.id };
}

/**
 * fetchResult에 필요한 요청 정보를 job 레코드에서 복원한다.
 * 캐스트와 레퍼런스도 함께 복원한다 — 제공자에 따라 결과 조회 시점에 필요하고,
 * 비어 있으면 실제 API 연동에서 조용히 깨진다.
 */
async function rebuildRequest(generationJobId: string): Promise<GenerationRequest> {
  const j = await prisma.generationJob.findUniqueOrThrow({
    where: { id: generationJobId },
    include: { segment: { include: { project: { include: { cast: true } } } } },
  });
  const params = j.params as Record<string, unknown>;
  const savedRefs = (params.references as Array<{ identityId: string; assetIds: string[] }> | undefined) ?? [];

  const cast = await Promise.all(
    j.segment.project.cast.map(async (c) => {
      const assetIds = savedRefs.find((r) => r.identityId === c.identityId)?.assetIds ?? [];
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
    prompt: (params.prompt as string) ?? null,
    seed: j.seed ? Number(j.seed) : null,
    conditioningStrength: Number(params.conditioningStrength ?? 0.6),
    cast,
    sourceVideoKey: null, sourceTracksKey: null,
    outputKey: storageKey.segmentOutput(j.segment.projectId, j.segmentId, j.attempt),
  };
}

async function failJob(
  generationJobId: string, segmentId: string, projectId: string,
  data: { traceId: string; orgId: string }, code: string, detail: unknown,
) {
  await prisma.generationJob.update({
    where: { id: generationJobId },
    data: {
      status: 'FAILED', finishedAt: new Date(),
      errorCode: code, errorDetail: { detail: String(detail) } as never,
    },
  });

  const segment = await prisma.segment.findUnique({ where: { id: segmentId } });
  // 재시도 여지가 남았으면 PENDING으로 되돌려 다음 생성 요청을 받을 수 있게 한다 (§5.1)
  const exhausted = (segment?.attemptCount ?? 0) >= MAX_GENERATION_ATTEMPT || code === ErrorCode.GEN_CONTENT_POLICY;
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
    include: { segment: true },
    take: 100,
  });

  for (const j of stale) {
    await queues.generation.add(
      JOB_NAME.GENERATION_POLL,
      {
        traceId: `reconcile-${j.id}`, orgId: '', projectId: j.segment.projectId,
        segmentId: j.segmentId, generationJobId: j.id,
        providerJobId: j.providerJobId as string, pollCount: 0,
      },
      { delay: 1000, jobId: `reconcile-${j.id}-${Date.now()}` },
    );
  }
  if (stale.length > 0) childLogger({ component: 'reconciler' }).info({ count: stale.length }, 'requeued stale polls');
  return stale.length;
}
