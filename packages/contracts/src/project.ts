import { z } from 'zod';
import {
  AspectRatio, GenerationMode, MappingMethod, ProjectStatus, ProjectType, PromptReferenceKind, SegmentStatus,
} from './enums';

/** §6.3 Project / 생성 API DTO */

export const ProjectConfig = z.object({
  resolution: z.enum(['720p', '1080p', '2160p']).default('1080p'),
  fps: z.number().int().min(12).max(60).default(30),
  outputFormat: z.enum(['mp4', 'mov']).default('mp4'),
  style: z.record(z.unknown()).default({}),
  requiredMode: GenerationMode.default('pose-guided'),
  /** 출력 화면 비율. 미지정 시 16:9 — 받지 않는 제공자는 시작 이미지 비율을 따른다(§12.1) */
  aspectRatio: AspectRatio.default('16:9'),
  /**
   * 이 프로젝트에서 반드시 쓸 모델 code. 지정하면 라우터가 점수로 다른 모델(예: mock)을 고르지 않고,
   * 이 모델이 조건을 못 맞추면 조용히 대체하지 않고 생성이 실패한다. 비우면 점수 기준 자동 선택.
   */
  preferredModel: z.string().min(1).optional(),
});

export const CreateProjectRequest = z.object({
  title: z.string().min(1).max(200),
  projectType: ProjectType,
  config: ProjectConfig.optional(),
});

/** PATCH /projects/{id} — 생성 설정은 생성 전(DRAFT·READY)에만 바꿀 수 있다 */
export const UpdateProjectRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  config: z
    .object({
      requiredMode: GenerationMode.optional(),
      aspectRatio: AspectRatio.optional(),
      resolution: z.enum(['720p', '1080p', '2160p']).optional(),
      /** null이면 자동 선택으로 되돌린다 */
      preferredModel: z.string().min(1).nullable().optional(),
    })
    .optional(),
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

/** PATCH /projects/{id}/segments/{segmentId} — 세그먼트별 프롬프트. 비우면 씬 프롬프트를 쓴다 */
export const UpdateSegmentRequest = z.object({
  prompt: z.string().max(4000).nullable(),
});

/** 참고 이미지 형식 — 제공자 API와 OpenCV가 모두 읽을 수 있는 것만 받는다 */
export const PromptReferenceContentType = z.enum(['image/jpeg', 'image/png', 'image/webp']);

/** POST /projects/{id}/segments/{segmentId}/references/upload-url */
export const PromptReferenceUploadRequest = z
  .object({
    kind: PromptReferenceKind,
    /** 의상·헤어가 속한 캐스트 위치(0부터). 비우면 전원 공통 */
    slotIndex: z.number().int().min(0).nullable().optional(),
    contentType: PromptReferenceContentType,
    fileName: z.string().min(1).max(200),
  })
  .refine((v) => v.kind !== 'BACKGROUND' || v.slotIndex == null, {
    message: '배경은 특정 위치에 속하지 않습니다', path: ['slotIndex'],
  });

/** POST .../references/{referenceId}/confirm — 업로드 완료 확정 */
export const PromptReferenceConfirmRequest = z.object({ checksum: z.string().min(8) });

export const PromptReferenceDto = z.object({
  id: z.string().uuid(),
  kind: PromptReferenceKind,
  slotIndex: z.number().int().nullable(),
  fileName: z.string(),
  previewUrl: z.string().url().nullable(),
  createdAt: z.string().datetime(),
});

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
  /** 세그먼트에 직접 입력한 프롬프트 */
  prompt: z.string().nullable(),
  /** 세그먼트 프롬프트가 비었을 때 쓰는 씬 프롬프트 */
  scenePrompt: z.string().nullable(),
  /** 가장 최근 생성 시도에 실제로 쓰인 프롬프트 — 수정 후 재생성이 필요한지 판단할 수 있다 */
  lastPrompt: z.string().nullable(),
  /** 다음 생성에 붙는 참고 이미지(배경·의상·헤어) */
  references: z.array(PromptReferenceDto),
  /** 가장 최근 생성 요청에 붙었던 참고 이미지 id — 첨부를 바꾼 뒤 재생성이 필요한지 판단한다 */
  lastReferenceIds: z.array(z.string().uuid()),
  /** 가장 최근 생성에서 모델 이미지 한도 때문에 전달되지 못한 참고 이미지 id */
  lastDroppedReferenceIds: z.array(z.string().uuid()),
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
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;
export type ProjectDto = z.infer<typeof ProjectDto>;
export type CastMemberInput = z.infer<typeof CastMemberInput>;
export type CastDto = z.infer<typeof CastDto>;
export type SourceVideoUploadUrlRequest = z.infer<typeof SourceVideoUploadUrlRequest>;
export type SourceTrackDto = z.infer<typeof SourceTrackDto>;
export type TracksResponse = z.infer<typeof TracksResponse>;
export type ConfirmMappingsRequest = z.infer<typeof ConfirmMappingsRequest>;
export type SetScenesRequest = z.infer<typeof SetScenesRequest>;
export type UpdateSegmentRequest = z.infer<typeof UpdateSegmentRequest>;
export type PromptReferenceUploadRequest = z.infer<typeof PromptReferenceUploadRequest>;
export type PromptReferenceConfirmRequest = z.infer<typeof PromptReferenceConfirmRequest>;
export type PromptReferenceDto = z.infer<typeof PromptReferenceDto>;
export type GenerateRequest = z.infer<typeof GenerateRequest>;
