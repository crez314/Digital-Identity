import { z } from 'zod';
import { AssetType, CaptureSlot, EmbeddingKind, Expression, IdentityStatus, ProfileStatus } from './enums';

/** §6.1 Identity API DTO */

export const CreateIdentityRequest = z.object({
  code: z.string().regex(/^CRZ-[A-Z]\d{3}$/).optional(), // 미지정 시 서버 자동 발번
  displayName: z.string().min(1).max(120),
  legalName: z.string().max(200).optional(), // 저장 시 암호화 (§4.2)
});

export const UpdateIdentityRequest = z.object({
  displayName: z.string().min(1).max(120).optional(),
  status: IdentityStatus.optional(),
});

export const IdentityDto = z.object({
  id: z.string().uuid(),
  code: z.string(),
  displayName: z.string(),
  status: IdentityStatus,
  createdAt: z.string().datetime(),
  activeProfile: z
    .object({
      id: z.string().uuid(),
      version: z.number().int(),
      status: ProfileStatus,
      faceVariance: z.number().nullable(),
      builtAt: z.string().datetime().nullable(),
    })
    .nullable()
    .optional(),
});

export const AssetUploadUrlRequest = z.object({
  assetType: AssetType,
  captureSlot: CaptureSlot.optional(),
  expression: Expression.optional(),
  contentType: z.string(),
  fileName: z.string(),
});

export const AssetUploadUrlResponse = z.object({
  assetId: z.string().uuid(),
  storageKey: z.string(),
  uploadUrl: z.string().url(),
  expiresInSeconds: z.number().int(),
});

/** 업로드 완료 확정 → 품질검사 큐 투입 */
export const ConfirmAssetRequest = z.object({
  assetId: z.string().uuid(),
  checksum: z.string().min(8),
  sizeBytes: z.number().int().positive().optional(),
});

export const IdentityAssetDto = z.object({
  id: z.string().uuid(),
  assetType: AssetType,
  captureSlot: CaptureSlot.nullable(),
  expression: Expression.nullable(),
  storageKey: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  qualityScore: z.number().nullable(),
  isUsable: z.boolean(),
  createdAt: z.string().datetime(),
});

/** 캡처 슬롯 충족률 (§6.1 GET /identities/{id}/assets) */
export const SlotCoverageDto = z.object({
  requiredFaceSlots: z.array(CaptureSlot),
  requiredBodySlots: z.array(CaptureSlot),
  filledSlots: z.array(CaptureSlot),
  missingSlots: z.array(CaptureSlot),
  coverageRatio: z.number().min(0).max(1),
  buildable: z.boolean(),
});

export const AssetListResponse = z.object({
  assets: z.array(IdentityAssetDto),
  coverage: SlotCoverageDto,
});

export const ProfileDto = z.object({
  id: z.string().uuid(),
  identityId: z.string().uuid(),
  version: z.number().int(),
  status: ProfileStatus,
  faceVariance: z.number().nullable(),
  attributes: z.record(z.unknown()),
  modelBundle: z.record(z.unknown()),
  builtAt: z.string().datetime().nullable(),
});

export const EmbeddingDto = z.object({
  id: z.string().uuid(),
  assetId: z.string().uuid().nullable(),
  kind: EmbeddingKind,
  modelName: z.string(),
  modelVersion: z.string(),
  dim: z.number().int(),
  quality: z.number().nullable(),
});

export const JobAcceptedResponse = z.object({
  jobId: z.string(),
  queue: z.string(),
  traceId: z.string(),
});

export type CreateIdentityRequest = z.infer<typeof CreateIdentityRequest>;
export type IdentityDto = z.infer<typeof IdentityDto>;
export type SlotCoverageDto = z.infer<typeof SlotCoverageDto>;
export type ProfileDto = z.infer<typeof ProfileDto>;

export type UpdateIdentityRequest = z.infer<typeof UpdateIdentityRequest>;
export type AssetUploadUrlRequest = z.infer<typeof AssetUploadUrlRequest>;
export type AssetUploadUrlResponse = z.infer<typeof AssetUploadUrlResponse>;
export type ConfirmAssetRequest = z.infer<typeof ConfirmAssetRequest>;
export type IdentityAssetDto = z.infer<typeof IdentityAssetDto>;
export type AssetListResponse = z.infer<typeof AssetListResponse>;
export type EmbeddingDto = z.infer<typeof EmbeddingDto>;
export type JobAcceptedResponse = z.infer<typeof JobAcceptedResponse>;
