import { z } from 'zod';

/** 기술명세서 §4.2 의 TEXT 상태값을 단일 출처로 고정한다. */

export const UserRole = z.enum(['OWNER', 'ADMIN', 'PRODUCER', 'OPERATOR', 'VIEWER']);
export const IdentityStatus = z.enum(['DRAFT', 'ACTIVE', 'SUSPENDED', 'ARCHIVED']);
export const AssetType = z.enum(['FACE_IMAGE', 'BODY_IMAGE', 'VIDEO', 'MOTION_VIDEO']);
export const CaptureSlot = z.enum([
  'FRONT', 'LEFT_45', 'RIGHT_45', 'LEFT_90', 'RIGHT_90', 'UP', 'DOWN',
  'BODY_FRONT', 'BODY_LEFT', 'BODY_RIGHT', 'BODY_BACK',
]);
export const Expression = z.enum(['NEUTRAL', 'SMILE', 'SERIOUS', 'SINGING', 'TALKING', 'PERFORMANCE']);
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
  'ASSET_UPLOADED', 'ASSET_DEACTIVATED',
  'PROFILE_BUILT', 'PROFILE_ACTIVATED',
  'RIGHTS_CHANGED', 'RIGHTS_CHECKED',
  'IDENTITY_USED', 'PROJECT_GENERATED', 'MAPPING_CONFIRMED',
  'QC_MANUAL_ACCEPT', 'MASTER_FINALIZED', 'DERIVATIVE_CREATED', 'DISTRIBUTED',
]);

export type UserRole = z.infer<typeof UserRole>;
export type IdentityStatus = z.infer<typeof IdentityStatus>;
export type AssetType = z.infer<typeof AssetType>;
export type CaptureSlot = z.infer<typeof CaptureSlot>;
export type SegmentStatus = z.infer<typeof SegmentStatus>;
export type FindingType = z.infer<typeof FindingType>;
export type GenerationMode = z.infer<typeof GenerationMode>;
export type UsageType = z.infer<typeof UsageType>;
