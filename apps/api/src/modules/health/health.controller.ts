import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { PrismaClient } from '@crez/db';
import { PRISMA } from '../../common/prisma.module';
import { Public } from '../../common/auth/roles.decorator';
import { MlClient } from '../../common/ml/ml.client';
import { QueueService } from '../../common/queue/queue.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly ml: MlClient,
    private readonly queue: QueueService,
  ) {}

  @Get()
  @Public()
  async health() {
    const db = await this.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    const ml = await this.ml.health();
    const queues = await this.queue.counts().catch(() => null);
    return {
      status: db && ml.ok ? 'ok' : 'degraded',
      version: '1.1.0',
      components: { db, ml, queues: queues !== null },
      queues,
    };
  }
}
