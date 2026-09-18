import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { CurrentUser, TraceId } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { SpendService } from './spend.service';

const UpdateSpendPolicy = z.object({
  /** 월 상한(원). null이면 금액 상한을 걸지 않는다 */
  monthlyBudgetKrw: z.number().nonnegative().nullable().optional(),
  /** 1 크레딧의 원화 단가 — 이 값이 있어야 원화 한도를 적용할 수 있다 */
  creditUnitPriceKrw: z.number().positive().nullable().optional(),
  /** 단가를 모르는 동안 유료 생성을 막을지 */
  blockWhenUnpriced: z.boolean().optional(),
});

@ApiTags('spend')
@ApiBearerAuth()
@Controller('spend')
export class SpendController {
  constructor(private readonly svc: SpendService) {}

  @Get('policy')
  @RequirePermission('READ')
  @ApiOperation({ summary: '지출 한도 설정과 이번 달 사용 현황' })
  status(@CurrentUser() user: AuthUser) {
    return this.svc.status(user);
  }

  @Put('policy')
  @RequirePermission('ORG_MANAGE')
  @ApiOperation({ summary: '지출 한도 설정. 돈에 직접 닿는 변경이라 감사 로그에 남는다' })
  update(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateSpendPolicy)) body: z.infer<typeof UpdateSpendPolicy>,
    @TraceId() traceId: string,
  ) {
    return this.svc.update(user, body, traceId);
  }
}
