import { z } from 'zod';

/** 기술명세서 §4.2 의 TEXT 상태값을 단일 출처로 고정한다. */

export const UserRole = z.enum(['OWNER', 'ADMIN', 'PRODUCER', 'OPERATOR', 'VIEWER']);
export const IdentityStatus = z.enum(['DRAFT', 'ACTIVE', 'SUSPENDED', 'ARCHIVED']);
/**
 * UNSORTED: 슬롯을 지정하지 않고 한꺼번에 올린 사진. 워커가 측정해 FACE_IMAGE/BODY_IMAGE로 바꾼다.
 * 분류에 실패하면 UNSORTED로 남아 사람이 슬롯을 정해 줄 때까지 프로파일에 들어가지 않는다.
 */
export const AssetType = z.enum(['FACE_IMAGE', 'BODY_IMAGE', 'VIDEO', 'MOTION_VIDEO', 'UNSORTED']);
export const CaptureSlot = z.enum([
  'FRONT', 'LEFT_45', 'RIGHT_45', 'LEFT_90', 'RIGHT_90', 'UP', 'DOWN',
  'BODY_FRONT', 'BODY_LEFT', 'BODY_RIGHT', 'BODY_BACK',
]);
export const Expression = z.enum(['NEUTRAL', 'SMILE', 'SERIOUS', 'SINGING', 'TALKING', 'PERFORMANCE']);
/** 세그먼트 프롬프트에 붙이는 참고 이미지 종류 */
export const PromptReferenceKind = z.enum(['BACKGROUND', 'OUTFIT', 'HAIR']);
/** 자산 품질검사 제외 사유 (§17 CREZ-IDN-002의 세부) */
export const AssetRejectReason = z.enum([
  'NO_FACE',            // 얼굴 슬롯에서 얼굴 미검출
  'PROCESSING_FAILED',  // 디코딩·인코더 오류
  'LOW_QUALITY',        // 품질 점수 미달
  'FACE_TOO_SMALL',     // 얼굴 슬롯인데 얼굴이 작다 — 전신·반신 사진
  'NOT_FULL_BODY',      // 신체 슬롯인데 전신이 화면에 다 들어오지 않는다 — 얼굴·상반신 사진
  'BODY_FACE_MISSING',  // 전신 정면 슬롯인데 얼굴이 없다 — 다른 부위 사진
  'DEACTIVATED',        // 사용자가 삭제했으나 프로파일 재현을 위해 보존 — 재검사 대상이 아니다
  'UNCLASSIFIED',       // 자동 분류가 각도·구도를 판단하지 못했다 — 사람이 슬롯을 지정해야 한다
]);
/**
 * 출력 화면 비율 (§6.3). 미지정 시 16:9.
 * 비율 파라미터를 받지 않는 제공자(kling 등)는 시작 이미지 비율을 따르며, 그 사실을 경고로 남긴다(§12.1).
 */
export const AspectRatio = z.enum(['16:9', '9:16']);
export const EmbeddingKind = z.enum(['FACE', 'BODY']);
export const ProfileStatus = z.enum(['BUILDING', 'ACTIVE', 'ARCHIVED', 'FAILED']);

export const ConsentStatus = z.enum(['PENDING', 'GRANTED', 'REVOKED', 'EXPIRED']);
export const UsageType = z.enum(['MV', 'AD', 'CONCERT', 'SHORTS', 'TEASER', 'THUMBNAIL']);

export const ProjectType = z.enum(['MV', 'CONCERT', 'AD', 'SHORTS']);
export const ProjectStatus = z.enum([
  'DRAFT', 'READY', 'RUNNING', 'REVIEW', 'COMPLETED', 'FAILED', 'ARCHIVED',
]);
export const SegmentStatus = z.enum([
  'PENDING', 'GENERATING', 'QC', 'PASSED', 'FAILED', 'MANUAL_REVIEW',
]);
export const MappingMethod = z.enum(['AUTO', 'MANUAL', 'CORRECTED']);
export const ModelProvider = z.enum(['EXTERNAL_API', 'SELF_HOSTED']);
/**
 * 생성 모드.
 * 'reference' = 레퍼런스 이미지로 인물 신원을 조건화하는 방식(Higgsfield veo3.1 reference-to-video 등).
 * CREZ의 Identity conditioning에 가장 가까운 실제 상용 경로다.
 */
export const GenerationMode = z.enum(['i2v', 'v2v', 'pose-guided', 't2v', 'reference']);
export const JobStatus = z.enum(['QUEUED', 'SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);

export const QcStatus = z.enum(['RUNNING', 'PASSED', 'FAILED', 'ERROR']);
/** §4.2 qc_finding.finding_type */
export const FindingType = z.enum([
  'IDENTITY_DRIFT', 'IDENTITY_SWAP', 'IDENTITY_BLEND', 'TRACK_LOST',
  'FACE_ARTIFACT', 'HAND_ARTIFACT', 'TEMPORAL_FLICKER', 'COSTUME_INCONSISTENCY',
]);
export const Severity = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const RegenOutcome = z.enum(['IMPROVED', 'NO_CHANGE', 'WORSE', 'ESCALATED']);
export const DerivativeKind = z.enum(['SHORTS', 'REELS', 'TIKTOK', 'TEASER', 'THUMBNAIL', 'GIF']);
export const AuditAction = z.enum([
  'IDENTITY_CREATED', 'IDENTITY_UPDATED', 'IDENTITY_STATUS_CHANGED',
  'IDENTITY_DELETED', 'PROJECT_UPDATED', 'PROJECT_DELETED',
  'ASSET_UPLOADED', 'ASSET_DEACTIVATED', 'ASSET_DELETED', 'ASSET_RECHECKED',
  'PROFILE_BUILT', 'PROFILE_ACTIVATED',
  'RIGHTS_CHANGED', 'RIGHTS_CHECKED',
  'IDENTITY_USED', 'PROJECT_GENERATED', 'MAPPING_CONFIRMED', 'SEGMENT_PROMPT_CHANGED',
  'SEGMENT_REFERENCE_ADDED', 'SEGMENT_REFERENCE_REMOVED',
  'QC_MANUAL_ACCEPT', 'MASTER_FINALIZED', 'DERIVATIVE_CREATED', 'DISTRIBUTED',
]);

export type UserRole = z.infer<typeof UserRole>;
export type IdentityStatus = z.infer<typeof IdentityStatus>;
export type AssetType = z.infer<typeof AssetType>;
export type CaptureSlot = z.infer<typeof CaptureSlot>;
export type AssetRejectReason = z.infer<typeof AssetRejectReason>;
export type PromptReferenceKind = z.infer<typeof PromptReferenceKind>;
export type AspectRatio = z.infer<typeof AspectRatio>;
export type SegmentStatus = z.infer<typeof SegmentStatus>;
export type FindingType = z.infer<typeof FindingType>;
export type GenerationMode = z.infer<typeof GenerationMode>;
export type UsageType = z.infer<typeof UsageType>;
