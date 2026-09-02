import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@crez/db';
import { encryptField } from '@crez/db';
import {
  CrezError, ErrorCode, QUEUE, REQUIRED_BODY_SLOTS, REQUIRED_FACE_SLOTS, storageKey,
} from '@crez/shared';
import type { CaptureSlot, SlotCoverageDto } from '@crez/contracts';
import { JOB_NAME } from '@crez/contracts';
import { PRISMA } from '../../common/prisma.module';
import { S3Service } from '../../common/storage/s3.service';
import { QueueService } from '../../common/queue/queue.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth.types';

@Injectable()
export class IdentityService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly s3: S3Service,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  /** code 미지정 시 CRZ-Annn 자동 발번 (§6.1) */
  private async nextCode(orgId: string): Promise<string> {
    const last = await this.prisma.identity.findMany({
      where: { orgId, code: { startsWith: 'CRZ-A' } },
      orderBy: { code: 'desc' },
      take: 1,
    });
    const n = last.length ? Number(last[0].code.slice(5)) + 1 : 1;
    return `CRZ-A${String(n).padStart(3, '0')}`;
  }

  async create(user: AuthUser, input: { code?: string; displayName: string; legalName?: string }, traceId: string) {
    const code = input.code ?? (await this.nextCode(user.orgId));
    const identity = await this.prisma.identity.create({
      data: {
        orgId: user.orgId,
        code,
        displayName: input.displayName,
        legalName: encryptField(input.legalName ?? null),
        status: 'DRAFT',
      },
    });
    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'IDENTITY_CREATED',
      identityId: identity.id, payload: { code, displayName: input.displayName }, traceId,
    });
    return this.toDto(identity.id);
  }

  async list(orgId: string, params: { status?: string; q?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(params.limit ?? 20, 100);
    const rows = await this.prisma.identity.findMany({
      where: {
        orgId,
        ...(params.status ? { status: params.status } : {}),
        ...(params.q ? { OR: [{ displayName: { contains: params.q, mode: 'insensitive' } }, { code: { contains: params.q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      include: { profiles: { where: { status: 'ACTIVE' }, take: 1 } },
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
      id: r.id, code: r.code, displayName: r.displayName, status: r.status,
      createdAt: r.createdAt.toISOString(),
      activeProfile: r.profiles[0]
        ? {
            id: r.profiles[0].id, version: r.profiles[0].version, status: r.profiles[0].status,
            faceVariance: r.profiles[0].faceVariance ? Number(r.profiles[0].faceVariance) : null,
            builtAt: r.profiles[0].builtAt?.toISOString() ?? null,
          }
        : null,
    }));
    return { items, nextCursor: hasMore ? rows[limit - 1].id : null };
  }

  async toDto(id: string) {
    const r = await this.prisma.identity.findUnique({
      where: { id },
      include: { profiles: { orderBy: { version: 'desc' } } },
    });
    if (!r) throw new CrezError(ErrorCode.IDN_NOT_FOUND, undefined, { id }, 404);
    const active = r.profiles.find((p) => p.status === 'ACTIVE');
    return {
      id: r.id, code: r.code, displayName: r.displayName, status: r.status,
      createdAt: r.createdAt.toISOString(),
      activeProfile: active
        ? {
            id: active.id, version: active.version, status: active.status,
            faceVariance: active.faceVariance ? Number(active.faceVariance) : null,
            builtAt: active.builtAt?.toISOString() ?? null,
          }
        : null,
    };
  }

  async update(user: AuthUser, id: string, input: { displayName?: string; status?: string }, traceId: string) {
    const before = await this.prisma.identity.findUnique({ where: { id } });
    if (!before || before.orgId !== user.orgId) throw new CrezError(ErrorCode.IDN_NOT_FOUND, undefined, { id }, 404);
    await this.prisma.identity.update({ where: { id }, data: input });
    await this.audit.record({
      orgId: user.orgId, actorId: user.id,
      action: input.status && input.status !== before.status ? 'IDENTITY_STATUS_CHANGED' : 'IDENTITY_UPDATED',
      identityId: id,
      payload: { before: { displayName: before.displayName, status: before.status }, after: input },
      traceId,
    });
    return this.toDto(id);
  }

  /** presigned PUT URL 발급 (§6.1, §15) */
  async createUploadUrl(user: AuthUser, identityId: string, input: {
    assetType: string; captureSlot?: string; expression?: string; contentType: string; fileName: string;
  }) {
    const identity = await this.prisma.identity.findFirst({ where: { id: identityId, orgId: user.orgId } });
    if (!identity) throw new CrezError(ErrorCode.IDN_NOT_FOUND, undefined, { identityId }, 404);

    const assetId = randomUUID();
    const ext = (input.fileName.split('.').pop() ?? 'bin').toLowerCase();
    const key = storageKey.identityAsset(identityId, assetId, ext);
    const { url, expiresIn } = await this.s3.presignPut(key, input.contentType);

    // 업로드 확정 전까지는 is_usable=false로 두어 프로파일 빌드에 섞이지 않게 한다.
    await this.prisma.identityAsset.create({
      data: {
        id: assetId, identityId, assetType: input.assetType,
        captureSlot: input.captureSlot ?? null, expression: input.expression ?? null,
        storageKey: key, checksum: 'pending', isUsable: false,
      },
    });
    return { assetId, storageKey: key, uploadUrl: url, expiresInSeconds: expiresIn };
  }

  /** 업로드 완료 확정 → 품질 검사 큐 투입 (§6.1, §8 ingest) */
  async confirmAsset(user: AuthUser, identityId: string, input: { assetId: string; checksum: string }, traceId: string) {
    const asset = await this.prisma.identityAsset.findFirst({ where: { id: input.assetId, identityId } });
    if (!asset) throw new CrezError(ErrorCode.IDN_NOT_FOUND, '자산을 찾을 수 없음', input, 404);

    const head = await this.s3.head(asset.storageKey);
    if (!head.exists) {
      throw new CrezError(ErrorCode.IDN_ASSET_QUALITY, '업로드된 객체가 존재하지 않습니다', { key: asset.storageKey }, 409);
    }

    await this.prisma.identityAsset.update({
      where: { id: asset.id },
      data: { checksum: input.checksum, isUsable: true },
    });

    const jobId = await this.queue.add(QUEUE.INGEST, JOB_NAME.ASSET_QUALITY, {
      traceId, orgId: user.orgId, identityId, assetId: asset.id,
    });

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'ASSET_UPLOADED',
      identityId, payload: { assetId: asset.id, assetType: asset.assetType, captureSlot: asset.captureSlot }, traceId,
    });
    return { jobId, queue: QUEUE.INGEST, traceId };
  }

  /** §6.1 자산 목록 + 캡처 슬롯 충족률 */
  async listAssets(user: AuthUser, identityId: string) {
    const assets = await this.prisma.identityAsset.findMany({
      where: { identityId, identity: { orgId: user.orgId } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      assets: assets.map((a) => ({
        id: a.id, assetType: a.assetType, captureSlot: a.captureSlot, expression: a.expression,
        storageKey: a.storageKey, width: a.width, height: a.height, durationMs: a.durationMs,
        qualityScore: a.qualityScore ? Number(a.qualityScore) : null,
        isUsable: a.isUsable, createdAt: a.createdAt.toISOString(),
      })),
      coverage: this.coverage(assets.filter((a) => a.isUsable).map((a) => a.captureSlot)),
    };
  }

  coverage(slots: Array<string | null>): SlotCoverageDto {
    const filled = new Set(slots.filter(Boolean) as CaptureSlot[]);
    const required = [...REQUIRED_FACE_SLOTS, ...REQUIRED_BODY_SLOTS] as CaptureSlot[];
    const missing = required.filter((s) => !filled.has(s));
    return {
      requiredFaceSlots: [...REQUIRED_FACE_SLOTS] as CaptureSlot[],
      requiredBodySlots: [...REQUIRED_BODY_SLOTS] as CaptureSlot[],
      filledSlots: [...filled],
      missingSlots: missing,
      coverageRatio: Number(((required.length - missing.length) / required.length).toFixed(4)),
      buildable: missing.length === 0,
    };
  }

  /** 물리 삭제가 아닌 비활성화 (§6.1) — 감사 추적성 유지 */
  async deactivateAsset(user: AuthUser, identityId: string, assetId: string, traceId: string) {
    const asset = await this.prisma.identityAsset.findFirst({
      where: { id: assetId, identityId, identity: { orgId: user.orgId } },
    });
    if (!asset) throw new CrezError(ErrorCode.IDN_NOT_FOUND, '자산을 찾을 수 없음', { assetId }, 404);
    await this.prisma.identityAsset.update({ where: { id: assetId }, data: { isUsable: false } });
    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'ASSET_DEACTIVATED',
      identityId, payload: { assetId }, traceId,
    });
    return { ok: true };
  }

  /** 프로파일 신규 버전 빌드 요청 → jobId 반환 (§6.1) */
  async buildProfile(user: AuthUser, identityId: string, traceId: string) {
    const identity = await this.prisma.identity.findFirst({
      where: { id: identityId, orgId: user.orgId },
      include: { assets: { where: { isUsable: true } } },
    });
    if (!identity) throw new CrezError(ErrorCode.IDN_NOT_FOUND, undefined, { identityId }, 404);

    // §17 CREZ-IDN-001: 필수 캡처 슬롯 미충족이면 빌드 자체를 거절한다.
    const cov = this.coverage(identity.assets.map((a) => a.captureSlot));
    if (!cov.buildable) {
      throw new CrezError(ErrorCode.IDN_SLOT_INCOMPLETE, undefined, { missingSlots: cov.missingSlots }, 422);
    }

    const latest = await this.prisma.identityProfile.findFirst({
      where: { identityId }, orderBy: { version: 'desc' },
    });
    const version = (latest?.version ?? 0) + 1;
    const profile = await this.prisma.identityProfile.create({
      data: { identityId, version, status: 'BUILDING', attributes: {}, modelBundle: {} },
    });

    const jobId = await this.queue.add(QUEUE.INGEST, JOB_NAME.PROFILE_BUILD, {
      traceId, orgId: user.orgId, identityId, profileId: profile.id, version,
    });
    return { jobId, queue: QUEUE.INGEST, traceId, profileId: profile.id, version };
  }

  async listProfiles(user: AuthUser, identityId: string) {
    const rows = await this.prisma.identityProfile.findMany({
      where: { identityId, identity: { orgId: user.orgId } },
      orderBy: { version: 'desc' },
    });
    return rows.map((p) => ({
      id: p.id, identityId: p.identityId, version: p.version, status: p.status,
      faceVariance: p.faceVariance ? Number(p.faceVariance) : null,
      attributes: p.attributes as Record<string, unknown>,
      modelBundle: p.modelBundle as Record<string, unknown>,
      builtAt: p.builtAt?.toISOString() ?? null,
    }));
  }

  /**
   * 해당 버전을 ACTIVE로 승격 (§6.1).
   * 기존 ACTIVE는 ARCHIVED로 내린다. 이미 이 버전을 pin한 프로젝트는 영향받지 않는다(§4.1).
   */
  async activateProfile(user: AuthUser, identityId: string, version: number, traceId: string) {
    const profile = await this.prisma.identityProfile.findFirst({
      where: { identityId, version, identity: { orgId: user.orgId } },
    });
    if (!profile) throw new CrezError(ErrorCode.IDN_NOT_FOUND, '프로파일 버전을 찾을 수 없음', { version }, 404);
    if (profile.status !== 'ACTIVE' && profile.status !== 'ARCHIVED') {
      throw new CrezError(ErrorCode.IDN_PROFILE_NOT_ACTIVE, `상태 ${profile.status}인 프로파일은 활성화할 수 없습니다`, null, 409);
    }

    await this.prisma.$transaction([
      this.prisma.identityProfile.updateMany({
        where: { identityId, status: 'ACTIVE' }, data: { status: 'ARCHIVED' },
      }),
      this.prisma.identityProfile.update({ where: { id: profile.id }, data: { status: 'ACTIVE' } }),
      this.prisma.identity.update({ where: { id: identityId }, data: { status: 'ACTIVE' } }),
    ]);

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'PROFILE_ACTIVATED',
      identityId, payload: { profileId: profile.id, version }, traceId,
    });
    return this.toDto(identityId);
  }
}
