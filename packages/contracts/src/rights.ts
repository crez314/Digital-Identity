import { z } from 'zod';
import { ConsentStatus, UsageType } from './enums';

/** §6.2 Rights API / §14.1 권리 게이트 */

export const RightsUpsertRequest = z.object({
  ownerName: z.string().min(1),
  contractRef: z.string().optional(),
  consentStatus: ConsentStatus,
  allowedUsage: z.array(UsageType).default([]),
  restrictedUsage: z.array(UsageType).default([]),
  territories: z.array(z.string().regex(/^[A-Z]{2}$/)).default([]), // ISO 3166-1 alpha-2
  commercialUse: z.boolean().default(false),
  trainingPermitted: z.boolean().default(false),
  syntheticPermitted: z.boolean().default(false),
  startsAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable().optional(),
  documentKey: z.string().optional(),
});

export const RightsDto = RightsUpsertRequest.extend({
  id: z.string().uuid(),
  identityId: z.string().uuid(),
  createdAt: z.string().datetime(),
});

/** POST /rights/check — 인물별 허용/거부와 사유 */
export const RightsCheckRequest = z.object({
  identityIds: z.array(z.string().uuid()).min(1),
  usageType: UsageType,
  territory: z.string().regex(/^[A-Z]{2}$/).optional(),
  at: z.string().datetime().optional(), // 미지정 시 now
});

export const RightsCheckItem = z.object({
  identityId: z.string().uuid(),
  allowed: z.boolean(),
  reasonCode: z.string().nullable(), // CREZ-RGT-00N
  reason: z.string().nullable(),
});

export const RightsCheckResponse = z.object({
  allowed: z.boolean(), // 전원 허용일 때만 true
  results: z.array(RightsCheckItem),
  checkedAt: z.string().datetime(),
});

export type RightsUpsertRequest = z.infer<typeof RightsUpsertRequest>;
export type RightsCheckRequest = z.infer<typeof RightsCheckRequest>;
export type RightsCheckResponse = z.infer<typeof RightsCheckResponse>;

export type RightsDto = z.infer<typeof RightsDto>;
export type RightsCheckItem = z.infer<typeof RightsCheckItem>;
