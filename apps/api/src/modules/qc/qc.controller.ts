import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AcceptSegmentRequest, QcThresholds, RegenerateRequest, ScoreWeights } from '@crez/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, TraceId } from '../../common/auth/current-user.decorator';
import { RequirePermission } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { RulesetService } from '../../common/ruleset/ruleset.service';
import { QcService } from './qc.service';

const CreateRulesetRequest = z.object({
  version: z.string().min(1),
  weights: ScoreWeights,
  thresholds: QcThresholds,
  note: z.string().optional(),
});

/** §6.4 QC / 재생성 API */
@ApiTags('qc')
@ApiBearerAuth()
@Controller()
export class QcController {
  constructor(private readonly svc: QcService, private readonly rulesets: RulesetService) {}

  @Get('segments/:id/qc-runs')
  @RequirePermission('READ')
  listRuns(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.listRuns(user, id);
  }

  @Get('qc-runs/:id')
  @RequirePermission('READ')
  @ApiOperation({ summary: '점수·findings·유사도 시계열' })
  getRun(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.getRun(user, id);
  }

  @Post('segments/:id/regenerate')
  @RequirePermission('PROJECT_RUN')
  @ApiOperation({ summary: '수동 재생성. 전략 override 가능 (§11)' })
  regenerate(
    @CurrentUser() user: AuthUser, @Param('id') id: string,
    @Body(new ZodValidationPipe(RegenerateRequest)) body: RegenerateRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.regenerate(user, id, body, traceId);
  }

  @Post('segments/:id/accept')
  @RequirePermission('QC_ACCEPT')
  @ApiOperation({ summary: 'QC 실패 세그먼트를 운영자 판단으로 승인 (사유 필수)' })
  accept(
    @CurrentUser() user: AuthUser, @Param('id') id: string,
    @Body(new ZodValidationPipe(AcceptSegmentRequest)) body: AcceptSegmentRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.accept(user, id, body, traceId);
  }

  // ── §10 ruleset 버전 관리 및 임계값 튜닝 (Phase 2 화면 백엔드) ──
  @Get('qc/rulesets')
  @RequirePermission('READ')
  listRulesets() {
    return this.rulesets.list();
  }

  @Get('qc/rulesets/active')
  @RequirePermission('READ')
  activeRuleset() {
    return this.rulesets.active();
  }

  @Post('qc/rulesets')
  @RequirePermission('MODEL_MANAGE')
  @ApiOperation({ summary: '새 ruleset 버전 등록 (활성화는 별도 호출)' })
  createRuleset(@Body(new ZodValidationPipe(CreateRulesetRequest)) body: z.infer<typeof CreateRulesetRequest>) {
    return this.rulesets.create(body);
  }

  @Put('qc/rulesets/:version/activate')
  @RequirePermission('MODEL_MANAGE')
  activateRuleset(@Param('version') version: string) {
    return this.rulesets.activate(version);
  }
}
