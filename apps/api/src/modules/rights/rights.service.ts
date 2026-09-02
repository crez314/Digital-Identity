import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@crez/db';
import type { RightsCheckResponse, RightsUpsertRequest } from '@crez/contracts';
import { CrezError, ErrorCode, QUEUE } from '@crez/shared';
import { PRISMA } from '../../common/prisma.module';
import { AuditService } from '../../common/audit/audit.service';
import { QueueService } from '../../common/queue/queue.service';
import type { AuthUser } from '../../common/auth/auth.types';

export type RightsGate = 'CASTING' | 'GENERATION' | 'DISTRIBUTION';

/**
 * §14.1 권리 게이트.
 * 검사는 세 지점에서 강제한다 — 캐스팅 확정 시 / 생성 job 제출 직전 / 배포 시.
 * 한 곳만 막으면 우회 경로가 생긴다.
 */
@Injectable()
export class RightsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async upsert(user: AuthUser, identityId: string, input: RightsUpsertRequest, traceId: string) {
    const identity = await this.prisma.identity.findFirst({ where: { id: identityId, orgId: user.orgId } });
    if (!identity) throw new CrezError(ErrorCode.IDN_NOT_FOUND, undefined, { identityId }, 404);

    const before = await this.current(identityId);

    // 권리 정보는 이력이 남아야 하므로 갱신이 아니라 새 레코드를 추가한다(§14.2 전후 값 보존).
    const created = await this.prisma.identityRights.create({
      data: {
        identityId,
        ownerName: input.ownerName,
        contractRef: input.contractRef ?? null,
        consentStatus: input.consentStatus,
        allowedUsage: input.allowedUsage,
        restrictedUsage: input.restrictedUsage,
        territories: input.territories,
        commercialUse: input.commercialUse,
        trainingPermitted: input.trainingPermitted,
        syntheticPermitted: input.syntheticPermitted,
        startsAt: new Date(input.startsAt),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        documentKey: input.documentKey ?? null,
      },
    });

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'RIGHTS_CHANGED', identityId,
      payload: { before, after: created }, traceId,
    });

    // §14.1 consent 철회 시 실행 중 job 즉시 취소 + 완성 콘텐츠 배포 차단
    if (input.consentStatus === 'REVOKED') {
      await this.onConsentRevoked(user, identityId, traceId);
    }
    return created;
  }

  private async onConsentRevoked(user: AuthUser, identityId: string, traceId: string) {
    const casts = await this.prisma.projectCast.findMany({
      where: { identityId },
      select: { projectId: true },
    });
    const projectIds = [...new Set(casts.map((c) => c.projectId))];

    let cancelledJobs = 0;
    for (const projectId of projectIds) {
      cancelledJobs += await this.queue.cancelByProject(projectId);
    }

    await this.prisma.generationJob.updateMany({
      where: {
        status: { in: ['QUEUED', 'SUBMITTED', 'RUNNING'] },
        segment: { projectId: { in: projectIds } },
      },
      data: { status: 'CANCELLED', errorCode: ErrorCode.RGT_CONSENT_INVALID, finishedAt: new Date() },
    });

    // 완성된 콘텐츠는 RESTRICTED로 표시해 배포를 차단한다(삭제하지 않는다 — 감사 대상).
    await this.prisma.masterVideo.updateMany({
      where: { projectId: { in: projectIds } }, data: { restricted: true },
    });

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'RIGHTS_CHANGED', identityId,
      payload: { event: 'CONSENT_REVOKED', projectIds, cancelledJobs, queue: QUEUE.GENERATION }, traceId,
    });
  }

  async current(identityId: string) {
    return this.prisma.identityRights.findFirst({
      where: { identityId }, orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * §6.2 POST /rights/check — 인물별 허용/거부와 사유.
   * 판단 근거를 사유 코드(CREZ-RGT-00N)로 돌려주어 UI가 그대로 표시할 수 있게 한다.
   */
  async check(
    user: AuthUser,
    input: { identityIds: string[]; usageType: string; territory?: string; at?: string },
    gate: RightsGate,
    traceId: string,
    opts: { persist?: boolean } = {},
  ): Promise<RightsCheckResponse & { checkId?: string }> {
    const at = input.at ? new Date(input.at) : new Date();
    const rows = await this.prisma.identityRights.findMany({
      where: { identityId: { in: input.identityIds } },
      orderBy: { createdAt: 'desc' },
    });

    // 인물별 최신 레코드만 사용
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.identityId)) latest.set(r.identityId, r);

    const results = input.identityIds.map((identityId) => {
      const r = latest.get(identityId);
      if (!r) {
        return { identityId, allowed: false, reasonCode: ErrorCode.RGT_CONSENT_INVALID, reason: '권리 정보가 등록되지 않음' };
      }
      if (r.consentStatus !== 'GRANTED') {
        return { identityId, allowed: false, reasonCode: ErrorCode.RGT_CONSENT_INVALID, reason: `consent 상태 ${r.consentStatus}` };
      }
      if (r.startsAt > at) {
        return { identityId, allowed: false, reasonCode: ErrorCode.RGT_CONSENT_INVALID, reason: `계약 시작 전 (${r.startsAt.toISOString()})` };
      }
      if (r.expiresAt && r.expiresAt < at) {
        return { identityId, allowed: false, reasonCode: ErrorCode.RGT_CONSENT_INVALID, reason: `계약 만료 (${r.expiresAt.toISOString()})` };
      }
      if (!r.syntheticPermitted) {
        return { identityId, allowed: false, reasonCode: ErrorCode.RGT_USAGE_NOT_ALLOWED, reason: '합성 콘텐츠 생성 미허용' };
      }
      if (r.restrictedUsage.includes(input.usageType)) {
        return { identityId, allowed: false, reasonCode: ErrorCode.RGT_USAGE_NOT_ALLOWED, reason: `제한 용도 ${input.usageType}` };
      }
      if (r.allowedUsage.length > 0 && !r.allowedUsage.includes(input.usageType)) {
        return { identityId, allowed: false, reasonCode: ErrorCode.RGT_USAGE_NOT_ALLOWED, reason: `허용 용도 밖 (${r.allowedUsage.join(',')})` };
      }
      if (input.territory && r.territories.length > 0 && !r.territories.includes(input.territory)) {
        return { identityId, allowed: false, reasonCode: ErrorCode.RGT_TERRITORY_NOT_ALLOWED, reason: `허용 지역 밖 (${r.territories.join(',')})` };
      }
      return { identityId, allowed: true, reasonCode: null, reason: null };
    });

    const allowed = results.every((r) => r.allowed);
    const response: RightsCheckResponse & { checkId?: string } = {
      allowed, results, checkedAt: at.toISOString(),
    };

    if (opts.persist) {
      const rec = await this.prisma.rightsCheck.create({
        data: {
          orgId: user.orgId, gate, usageType: input.usageType,
          territory: input.territory ?? null, allowed, results: results as never,
        },
      });
      response.checkId = rec.id;
    }

    await this.audit.record({
      orgId: user.orgId, actorId: user.id, action: 'RIGHTS_CHECKED',
      payload: { gate, usageType: input.usageType, territory: input.territory ?? null, allowed, results }, traceId,
    });
    return response;
  }

  /** 게이트 강제 — 거부되면 예외를 던진다 */
  async enforce(
    user: AuthUser,
    input: { identityIds: string[]; usageType: string; territory?: string },
    gate: RightsGate,
    traceId: string,
  ): Promise<string | undefined> {
    const res = await this.check(user, input, gate, traceId, { persist: true });
    if (!res.allowed) {
      const denied = res.results.filter((r) => !r.allowed);
      const code = denied[0].reasonCode === ErrorCode.RGT_TERRITORY_NOT_ALLOWED
        ? ErrorCode.RGT_TERRITORY_NOT_ALLOWED
        : denied[0].reasonCode === ErrorCode.RGT_USAGE_NOT_ALLOWED
        ? ErrorCode.RGT_USAGE_NOT_ALLOWED
        : ErrorCode.RGT_CONSENT_INVALID;
      throw new CrezError(code, `권리 게이트(${gate}) 거부`, { denied }, 403);
    }
    return res.checkId;
  }
}
