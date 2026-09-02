import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateDerivativesRequest, CreateMasterRequest } from '@crez/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, TraceId } from '../../common/auth/current-user.decorator';
import { RequirePermission } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { MasterService } from './master.service';

@ApiTags('masters')
@ApiBearerAuth()
@Controller()
export class MasterController {
  constructor(private readonly svc: MasterService) {}

  @Post('projects/:id/master')
  @RequirePermission('PROJECT_RUN')
  @ApiOperation({ summary: 'PASSED 세그먼트 결합 → 마스터 생성' })
  create(
    @CurrentUser() user: AuthUser, @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateMasterRequest)) body: CreateMasterRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.createMaster(user, id, body, traceId);
  }

  @Get('projects/:id/masters')
  @RequirePermission('READ')
  list(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.listMasters(user, id);
  }

  @Get('masters/:id/provenance')
  @RequirePermission('READ')
  @ApiOperation({ summary: '§14.3 생성 이력 역추적' })
  provenance(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.getProvenance(user, id);
  }

  @Post('masters/:id/derivatives')
  @RequirePermission('PROJECT_RUN')
  @ApiOperation({ summary: '파생 콘텐츠 생성 요청 (§13)' })
  derivatives(
    @CurrentUser() user: AuthUser, @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateDerivativesRequest)) body: CreateDerivativesRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.createDerivatives(user, id, body, traceId);
  }
}
