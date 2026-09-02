import { z } from 'zod';
import { GenerationMode, MappingMethod, ProjectStatus, ProjectType, SegmentStatus } from './enums';

/** §6.3 Project / 생성 API DTO */

export const ProjectConfig = z.object({
  resolution: z.enum(['720p', '1080p', '2160p']).default('1080p'),
  fps: z.number().int().min(12).max(60).default(30),
  outputFormat: z.enum(['mp4', 'mov']).default('mp4'),
  style: z.record(z.unknown()).default({}),
  requiredMode: GenerationMode.default('pose-guided'),
});

export const CreateProjectRequest = z.object({
  title: z.string().min(1).max(200),
  projectType: ProjectType,
  config: ProjectConfig.optional(),
});

export const ProjectDto = z.object({
  id: z.string().uuid(),
  title: z.string(),
  projectType: ProjectType,
  status: ProjectStatus,
  config: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});

/** PUT /projects/{id}/cast — 내부적으로 권리검사 후 profile version 고정 (§6.3) */
export const CastMemberInput = z.object({
  identityId: z.string().uuid(),
  slotIndex: z.number().int().min(0),
  roleLabel: z.string().optional(),
  /** 헤어/의상/메이크업 = Variable Attribute (§4.2 project_cast.appearance) */
  appearance: z.record(z.unknown()).default({}),
  /** 미지정 시 해당 Identity의 ACTIVE 프로파일을 고정 */
  profileId: z.string().uuid().optional(),
});

export const SetCastRequest = z.object({
  cast: z.array(CastMemberInput).min(1).max(10),
  usageType: z.string(),
  territory: z.string().regex(/^[A-Z]{2}$/).optional(),
});

export const CastDto = z.object({
  id: z.string().uuid(),
  identityId: z.string().uuid(),
  identityCode: z.string(),
  displayName: z.string(),
  profileId: z.string().uuid(),
  profileVersion: z.number().int(),
  slotIndex: z.number().int(),
  roleLabel: z.string().nullable(),
  appearance: z.record(z.unknown()),
});

export const SourceVideoUploadUrlRequest = z.object({
  fileName: z.string(),
  contentType: z.string(),
  durationMs: z.number().int().positive().optional(),
});

export const SourceTrackDto = z.object({
  id: z.string().uuid(),
  trackIndex: z.number().int(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  quality: z.number().nullable(),
  /** 자동 매핑 제안 (§9.1) */
  suggestion: z
    .object({
      projectCastId: z.string().uuid().nullable(),
      identityId: z.string().uuid().nullable(),
      confidence: z.number(),
      /** τ_assign / δ_margin 미달로 운영자 확인이 필요한 트랙 */
      needsReview: z.boolean(),
      runnerUpMargin: z.number().nullable(),
    })
    .nullable(),
});

export const TracksResponse = z.object({
  analysisStatus: z.string(),
  tracks: z.array(SourceTrackDto),
});

export const ConfirmMappingsRequest = z.object({
  mappings: z
    .array(
      z.object({
        sourceTrackId: z.string().uuid(),
        projectCastId: z.string().uuid(),
        method: MappingMethod.default('CORRECTED'),
      }),
    )
    .min(1),
});

export const SceneInput = z.object({
  sceneIndex: z.number().int().min(0),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  prompt: z.string().optional(),
  style: z.record(z.unknown()).optional(),
  /** 씬 내부 세그먼트 분할 경계 (ms). 미지정 시 씬 전체가 1 세그먼트 */
  segmentBoundariesMs: z.array(z.number().int()).optional(),
});

export const SetScenesRequest = z.object({ scenes: z.array(SceneInput).min(1) });

export const GenerateRequest = z.object({
  segmentIds: z.array(z.string().uuid()).optional(), // 미지정 시 PENDING 전체
  modelHint: z.string().optional(),
  priority: z.number().int().min(1).max(10).default(5),
});

export const SegmentDto = z.object({
  id: z.string().uuid(),
  segmentIndex: z.number().int(),
  sceneId: z.string().uuid().nullable(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  status: SegmentStatus,
  attemptCount: z.number().int(),
  acceptedOutputId: z.string().uuid().nullable(),
  latestScore: z.number().nullable(),
});

/** GET /projects/{id}/events (SSE) 이벤트 페이로드 */
export const ProjectEvent = z.object({
  type: z.enum([
    'SEGMENT_STATUS', 'JOB_PROGRESS', 'QC_COMPLETED', 'PROJECT_STATUS', 'ERROR', 'HEARTBEAT',
  ]),
  projectId: z.string().uuid(),
  segmentId: z.string().uuid().optional(),
  payload: z.record(z.unknown()),
  at: z.string().datetime(),
  traceId: z.string().optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfig>;
export type SetCastRequest = z.infer<typeof SetCastRequest>;
export type SegmentDto = z.infer<typeof SegmentDto>;
export type ProjectEvent = z.infer<typeof ProjectEvent>;
export type SceneInput = z.infer<typeof SceneInput>;

export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
export type ProjectDto = z.infer<typeof ProjectDto>;
export type CastMemberInput = z.infer<typeof CastMemberInput>;
export type CastDto = z.infer<typeof CastDto>;
export type SourceVideoUploadUrlRequest = z.infer<typeof SourceVideoUploadUrlRequest>;
export type SourceTrackDto = z.infer<typeof SourceTrackDto>;
export type TracksResponse = z.infer<typeof TracksResponse>;
export type ConfirmMappingsRequest = z.infer<typeof ConfirmMappingsRequest>;
export type SetScenesRequest = z.infer<typeof SetScenesRequest>;
export type GenerateRequest = z.infer<typeof GenerateRequest>;
