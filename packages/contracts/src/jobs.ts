import { z } from 'zod';
import { QUEUE_NAMES } from './queues';

/** §8 모든 job payload는 traceId/projectId/segmentId/attempt를 포함한다. */
export const JobBase = z.object({
  traceId: z.string(),
  orgId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  segmentId: z.string().uuid().optional(),
  attempt: z.number().int().optional(),
});

export const AssetQualityJob = JobBase.extend({
  identityId: z.string().uuid(),
  assetId: z.string().uuid(),
});

export const ProfileBuildJob = JobBase.extend({
  identityId: z.string().uuid(),
  profileId: z.string().uuid(),
  version: z.number().int(),
});

export const SourceAnalyzeJob = JobBase.extend({
  projectId: z.string().uuid(),
  sourceVideoId: z.string().uuid(),
});

/**
 * 라우팅은 워커가 제출 직전에 수행한다(quota를 실시간 반영해야 하므로).
 * 따라서 generation_job 레코드는 워커가 모델을 확정한 뒤 생성한다.
 */
export const GenerationJobPayload = JobBase.extend({
  projectId: z.string().uuid(),
  segmentId: z.string().uuid(),
  attempt: z.number().int(),
  modelHint: z.string().optional(),
  /** §11 재생성 전략 — 있으면 이 시도에 적용한다 */
  strategy: z
    .object({
      step: z.number().int(),
      kind: z.string(),
      params: z.record(z.unknown()),
      rationale: z.string(),
    })
    .optional(),
  regenerationTaskId: z.string().uuid().optional(),
  /** 직전 QC 점수 — 재생성 결과 분류(IMPROVED/NO_CHANGE/WORSE)에 사용 */
  scoreBefore: z.number().nullable().optional(),
});

export const GenerationPollJob = JobBase.extend({
  generationJobId: z.string().uuid(),
  providerJobId: z.string(),
  pollCount: z.number().int().default(0),
});

export const QcJobPayload = JobBase.extend({
  projectId: z.string().uuid(),
  segmentId: z.string().uuid(),
  outputId: z.string().uuid(),
  attempt: z.number().int(),
});

export const RegenerationJobPayload = JobBase.extend({
  projectId: z.string().uuid(),
  segmentId: z.string().uuid(),
  qcRunId: z.string().uuid(),
});

export const MasterJobPayload = JobBase.extend({
  projectId: z.string().uuid(),
  masterId: z.string().uuid(),
  normalizeColor: z.boolean().default(true),
  normalizeTiming: z.boolean().default(true),
});

export const DerivativeJobPayload = JobBase.extend({
  projectId: z.string().uuid(),
  masterId: z.string().uuid(),
  derivativeId: z.string().uuid(),
  kind: z.string(),
  aspectRatio: z.string(),
});

export const JOB_NAME = {
  ASSET_QUALITY: 'asset.quality',
  PROFILE_BUILD: 'profile.build',
  SOURCE_ANALYZE: 'source.analyze',
  GENERATION_SUBMIT: 'generation.submit',
  GENERATION_POLL: 'generation.poll',
  QC_RUN: 'qc.run',
  REGENERATION_PLAN: 'regeneration.plan',
  MASTER_BUILD: 'master.build',
  DERIVATIVE_BUILD: 'derivative.build',
} as const;

export { QUEUE_NAMES };
export type GenerationJobPayload = z.infer<typeof GenerationJobPayload>;
export type QcJobPayload = z.infer<typeof QcJobPayload>;
export type RegenerationJobPayload = z.infer<typeof RegenerationJobPayload>;
export type ProfileBuildJob = z.infer<typeof ProfileBuildJob>;
export type SourceAnalyzeJob = z.infer<typeof SourceAnalyzeJob>;
export type MasterJobPayload = z.infer<typeof MasterJobPayload>;
export type DerivativeJobPayload = z.infer<typeof DerivativeJobPayload>;
export type GenerationPollJob = z.infer<typeof GenerationPollJob>;
export type AssetQualityJob = z.infer<typeof AssetQualityJob>;
