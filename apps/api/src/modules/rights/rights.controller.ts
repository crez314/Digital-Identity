import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RightsCheckRequest, RightsUpsertRequest } from '@crez/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, TraceId } from '../../common/auth/current-user.decorator';
import { RequirePermission } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { RightsService } from './rights.service';

/** §6.2 Rights API */
@ApiTags('rights')
@ApiBearerAuth()
@Controller()
export class RightsController {
  constructor(private readonly svc: RightsService) {}

  @Put('identities/:id/rights')
  @RequirePermission('RIGHTS_WRITE')
  @ApiOperation({ summary: '권리 정보 등록/갱신. REVOKED 시 진행 중 job 취소 및 배포 차단' })
  upsert(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RightsUpsertRequest)) body: RightsUpsertRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.upsert(user, id, body, traceId);
  }

  @Get('identities/:id/rights')
  @RequirePermission('READ')
  current(@Param('id') id: string) {
    return this.svc.current(id);
  }

  @Post('rights/check')
  @RequirePermission('READ')
  @ApiOperation({ summary: '사전 검사. 인물별 허용/거부와 사유를 반환' })
  check(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(RightsCheckRequest)) body: RightsCheckRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.check(user, body, 'CASTING', traceId);
  }
}
