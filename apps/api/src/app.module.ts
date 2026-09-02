import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './common/auth/auth.module';
import { AuthGuard } from './common/auth/auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { PrismaModule } from './common/prisma.module';
import { StorageModule } from './common/storage/storage.module';
import { MlModule } from './common/ml/ml.module';
import { QueueModule } from './common/queue/queue.module';
import { AuditModule } from './common/audit/audit.module';
import { EventsModule } from './common/events/events.module';
import { RulesetModule } from './common/ruleset/ruleset.module';
import { IdentityModule } from './modules/identity/identity.module';
import { RightsModule } from './modules/rights/rights.module';
import { ProjectModule } from './modules/project/project.module';
import { QcModule } from './modules/qc/qc.module';
import { MasterModule } from './modules/master/master.module';
import { AuditReadModule } from './modules/audit/audit-read.module';
import { ModelsModule } from './modules/models/models.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    PrismaModule, StorageModule, MlModule, QueueModule, AuditModule, EventsModule, RulesetModule, AuthModule,
    IdentityModule, RightsModule, ProjectModule, QcModule, MasterModule, AuditReadModule, ModelsModule, HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
