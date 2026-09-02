import { Module } from '@nestjs/common';
import { AuditReadController } from './audit-read.controller';
import { KpiService } from './kpi.service';

@Module({ controllers: [AuditReadController], providers: [KpiService] })
export class AuditReadModule {}
