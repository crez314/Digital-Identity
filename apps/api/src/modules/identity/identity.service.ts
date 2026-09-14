import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@crez/db';
import { encryptField } from '@crez/db';
import { Prisma } from '@crez/db';
import {
  ASSET_QUALITY_POLICY, CrezError, ErrorCode, QUEUE, REQUIRED_BODY_SLOTS, REQUIRED_FACE_SLOTS, logger, storageKey,
} from '@crez/shared';
import type { CaptureSlot, SlotCoverageDto } from '@crez/contracts';
import { JOB_NAME } from '@crez/contracts';
import { PRISMA } from '../../common/prisma.module';
import { S3Service } from '../../common/storage/s3.service';
import { QueueService } from '../../common/queue/queue.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth.types';

/** 품질검사 큐에 넣기 전 상태 — 화면이 '검사 중'으로 보이도록 이전 판정을 비운다. */
const PENDING_CHECK = {
  isUsable: true, qualityScore: null, rejectReason: null, qualityDetail: Prisma.DbNull,
} satisfies Prisma.IdentityAssetUpdateInput;

/**
 * 워커가 판정한 자산인지 — 사용자가 직접 뺀 자산은 재검사로 되살리지 않는다.
 * reject_reason 도입 전에 제외된 자산은 사유가 없으므로 점수로 구분한다(자동 제외는 0점 또는 하한 미달).
 */
export function isAutoJudged(a: { isUsable: boolean; rejectReason: string | null; qualityScore: unknown }): boolean {
  if (a.isUsable) return true;
  if (a.rejectReason === 'DEACTIVATED') return false;
  if (a.rejectReason) return true;
  const q = a.qualityScore === null ? null : Number(a.qualityScore);
  return q !== null && q < ASSET_QUALITY_POLICY.minQuality;
}

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

  /**
   * Identity 삭제 — 사진·임베딩·프로파일·권리 기록이 함께 지워진다(FK CASCADE).
   * 프로젝트에 캐스팅된 인물은 그 프로젝트의 생성 기록이 가리키므로 먼저 캐스팅에서 빼거나 프로젝트를 지워야 한다
   * (DB도 project_cast FK RESTRICT로 막는다). 감사 로그에 삭제 전 요약을 남긴다(§14.2).
   */
  async remove(user: AuthUser, identityId: string, traceId: string) {
    const identity = await this.prisma.identity.findFirst({ where: { id: identityId, orgId: user.orgId } });
    if (!identity) throw new CrezError(ErrorCode.IDN_NOT_FOUND, undefined, { identityId }, 404);

    const casts = await this.prisma.projectCast.findMany({
      where: { identityId }, include: { project: { select: { id: true, title: true, status: true } } },
    });
    if (casts.length > 0) {
      const projects = casts.map((c) => c.project);
      throw new CrezError(
        ErrorCode.PRJ_INVALID_STATE,
        `프로젝트 ${projects.map((p) => `'${p.title}'`).join(', ')}에 캐스팅되어 있어 삭제할 수 없습니다 — 캐스팅에서 빼거나 프로젝트를 먼저 삭제하세요`,
        { projects }, 409,
      );
    }
    const [profiles, assetCount, rights] = await Promise.all([
      this.prisma.identityProfile.findMany({ where: { identityId }, select: { version: true, status: true } }),
      this.prisma.identityAsset.count({ where: { identityId } }),
      this.prisma.identityRights.findMany({ where: { identityId }, orderBy: { createdAt: 'desc' }, select: { consentStatus: true, createdAt: true } }),
    ]);
    if (profiles.some((p) => p.status === 'BUILDING')) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '프로파일 빌드 중에는 삭제할 수 없습니다', null, 409);
    }

    await this.prisma.identity.delete({ where: { id: identityId } });
    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'IDENTITY_DELETED', identityId,
      payload: {
        code: identity.code, displayName: identity.displayName, status: identity.status,
        assetCount, profiles, rightsRecords: rights.length, latestConsent: rights[0]?.consentStatus ?? null,
      },
      traceId,
    });

    let deletedObjects = 0;
    try {
      deletedObjects = await this.s3.deletePrefix(`identities/${identityId}/`);
    } catch (e) {
      logger.warn({ traceId, identityId, err: String(e) }, 'identity storage cleanup failed');
    }
    return { ok: true, deletedObjects };
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
      data: { checksum: input.checksum, ...PENDING_CHECK },
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
      assets: await Promise.all(assets.map(async (a) => ({
        id: a.id, assetType: a.assetType, captureSlot: a.captureSlot, expression: a.expression,
        storageKey: a.storageKey, width: a.width, height: a.height, durationMs: a.durationMs,
        qualityScore: a.qualityScore !== null ? Number(a.qualityScore) : null,
        isUsable: a.isUsable, createdAt: a.createdAt.toISOString(),
        rejectReason: a.rejectReason,
        qualityDetail: (a.qualityDetail as Record<string, unknown> | null) ?? null,
        // checksum이 'pending'이면 업로드 URL만 발급되고 객체는 아직 없다.
        previewUrl:
          a.checksum !== 'pending' && (a.assetType === 'FACE_IMAGE' || a.assetType === 'BODY_IMAGE')
            ? (await this.s3.presignGet(a.storageKey)).url
            : null,
      }))),
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

  /**
   * 자산 삭제 (§6.1).
   * 프로파일 빌드에 쓰였을 수 있는 자산은 재현성(§4.1)을 위해 지우지 않고 비활성화만 한다.
   * 빌드에 한 번도 들어가지 않은 자산(잘못 올린 사진 등)은 DB 행·임베딩·스토리지 객체를 실제로 지우고,
   * 무엇을 지웠는지는 감사 로그에 남긴다(§14.2).
   */
  async removeAsset(user: AuthUser, identityId: string, assetId: string, traceId: string) {
    const asset = await this.prisma.identityAsset.findFirst({
      where: { id: assetId, identityId, identity: { orgId: user.orgId } },
    });
    if (!asset) throw new CrezError(ErrorCode.IDN_NOT_FOUND, '자산을 찾을 수 없음', { assetId }, 404);

    // 빌드는 그 시점의 임베딩을 모두 집계하므로, 자산보다 나중에 시작된 빌드가 있으면 쓰였다고 본다.
    const usedByProfile = await this.prisma.identityProfile.count({
      where: { identityId, status: { in: ['BUILDING', 'ACTIVE', 'ARCHIVED'] }, createdAt: { gt: asset.createdAt } },
    });

    if (usedByProfile > 0) {
      // 사유를 남겨 두어야 재검사가 사용자가 뺀 자산을 되살리지 않는다.
      await this.prisma.identityAsset.update({
        where: { id: assetId }, data: { isUsable: false, rejectReason: 'DEACTIVATED' },
      });
      await this.audit.record({
        orgId: user.orgId, actorId: user.id, action: 'ASSET_DEACTIVATED',
        identityId, payload: { assetId, reason: 'USED_BY_PROFILE' }, traceId,
      });
      return { ok: true, mode: 'DEACTIVATED' as const };
    }

    // identity_embedding은 FK ON DELETE CASCADE로 함께 지워진다.
    await this.prisma.identityAsset.delete({ where: { id: assetId } });
    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'ASSET_DELETED', identityId,
      payload: {
        assetId, assetType: asset.assetType, captureSlot: asset.captureSlot,
        checksum: asset.checksum, storageKey: asset.storageKey,
      },
      traceId,
    });
    // 스토리지 정리는 DB 삭제 뒤에 한다. 실패해도 참조가 없는 객체만 남으므로 요청은 성공으로 둔다.
    try {
      await this.s3.delete(asset.storageKey);
    } catch (e) {
      logger.warn({ traceId, assetId, storageKey: asset.storageKey, err: String(e) }, 'asset object delete failed');
    }
    return { ok: true, mode: 'DELETED' as const };
  }

  /**
   * 업로드된 이미지 자산을 현재 기준(ASSET_QUALITY_POLICY)으로 다시 검사한다.
   * 판정 기준이 바뀌었거나 ML 오류로 실패한 자산을 다시 올리지 않고 복구하기 위한 경로다.
   * 사용자가 직접 뺀 자산은 되살리지 않는다.
   */
  async recheckAssets(user: AuthUser, identityId: string, traceId: string) {
    const identity = await this.prisma.identity.findFirst({ where: { id: identityId, orgId: user.orgId } });
    if (!identity) throw new CrezError(ErrorCode.IDN_NOT_FOUND, undefined, { identityId }, 404);

    // 빌드는 검사 시점의 사용 가능 자산을 읽으므로, 빌드 중에 판정을 뒤집으면 결과가 섞인다.
    const building = await this.prisma.identityProfile.count({ where: { identityId, status: 'BUILDING' } });
    if (building > 0) {
      throw new CrezError(ErrorCode.PRJ_INVALID_STATE, '프로파일 빌드 중에는 재검사할 수 없습니다', null, 409);
    }

    const assets = await this.prisma.identityAsset.findMany({
      where: { identityId, assetType: { in: ['FACE_IMAGE', 'BODY_IMAGE'] }, checksum: { not: 'pending' } },
    });
    const targets = assets.filter((a) => isAutoJudged(a));

    for (const a of targets) {
      await this.prisma.identityAsset.update({ where: { id: a.id }, data: PENDING_CHECK });
      await this.queue.add(QUEUE.INGEST, JOB_NAME.ASSET_QUALITY, {
        traceId, orgId: user.orgId, identityId, assetId: a.id,
      });
    }

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'ASSET_RECHECKED', identityId,
      payload: { assetIds: targets.map((a) => a.id), policy: ASSET_QUALITY_POLICY }, traceId,
    });
    return { queued: targets.length, skipped: assets.length - targets.length, traceId };
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
