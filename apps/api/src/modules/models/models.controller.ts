import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { PrismaClient } from '@crez/db';
import { PRISMA } from '../../common/prisma.module';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { RulesetService } from '../../common/ruleset/ruleset.service';
import { ModelMetricsService } from './model-metrics.service';

const UpsertModel = z.object({
  code: z.string().min(1),
  provider: z.enum(['EXTERNAL_API', 'SELF_HOSTED']),
  endpoint: z.string().nullable().optional(),
  capabilities: z.object({
    maxDurationMs: z.number().int().positive(),
    maxPersons: z.number().int().positive(),
    modes: z.array(z.string()),
    maxResolution: z.number().int().positive(),
  }),
  costPerSecond: z.number().nonnegative(),
  status: z.enum(['ACTIVE', 'DISABLED']).default('ACTIVE'),
});

@ApiTags('models')
@ApiBearerAuth()
@Controller('models')
export class ModelsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly metrics: ModelMetricsService,
    private readonly rulesets: RulesetService,
  ) {}

  @Get()
  @RequirePermission('READ')
  list() {
    return this.prisma.aiModel.findMany({ orderBy: { code: 'asc' } });
  }

  @Post()
  @RequirePermission('MODEL_MANAGE')
  upsert(@Body(new ZodValidationPipe(UpsertModel)) body: z.infer<typeof UpsertModel>) {
    return this.prisma.aiModel.upsert({
      where: { code: body.code },
      update: { ...body, capabilities: body.capabilities as never },
      create: { ...body, capabilities: body.capabilities as never },
    });
  }

  @Patch(':code/status')
  @RequirePermission('MODEL_MANAGE')
  setStatus(@Param('code') code: string, @Body() body: { status: string }) {
    return this.prisma.aiModel.update({ where: { code }, data: { status: body.status } });
  }

  @Post('metrics/refresh')
  @RequirePermission('MODEL_MANAGE')
  refresh() {
    return this.metrics.refreshAll();
  }

  @Get('routing/active')
  @RequirePermission('READ')
  routing() {
    return this.rulesets.activeRouting();
  }
}
