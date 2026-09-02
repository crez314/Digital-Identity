import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PrismaClient } from '@crez/db';
import { PRISMA } from '../../common/prisma.module';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermission } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { KpiService } from './kpi.service';

@ApiTags('audit')
@ApiBearerAuth()
@Controller()
export class AuditReadController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient, private readonly kpi: KpiService) {}

  @Get('identities/:id/audit')
  @RequirePermission('READ')
  @ApiOperation({ summary: '해당 인물 사용 이력 (§14.2)' })
  async identityAudit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const rows = await this.prisma.auditLog.findMany({
      where: { orgId: user.orgId, identityId: id },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(Number(limit ?? 100), 500),
    });
    return rows.map((r) => ({
      id: String(r.id), action: r.action, actorId: r.actorId, projectId: r.projectId,
      payload: r.payload, traceId: r.traceId, occurredAt: r.occurredAt.toISOString(),
    }));
  }

  @Get('projects/:id/audit')
  @RequirePermission('READ')
  async projectAudit(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('limit') limit?: string) {
    const rows = await this.prisma.auditLog.findMany({
      where: { orgId: user.orgId, projectId: id },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(Number(limit ?? 100), 500),
    });
    return rows.map((r) => ({
      id: String(r.id), action: r.action, actorId: r.actorId, identityId: r.identityId,
      payload: r.payload, traceId: r.traceId, occurredAt: r.occurredAt.toISOString(),
    }));
  }

  @Get('kpi')
  @RequirePermission('READ')
  @ApiOperation({ summary: '§20 KPI — 모두 DB 쿼리로 자동 산출' })
  kpis(@CurrentUser() user: AuthUser, @Query('projectId') projectId?: string) {
    return this.kpi.compute(user.orgId, projectId);
  }
}
