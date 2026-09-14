import { Module } from '@nestjs/common';
import { RightsModule } from '../rights/rights.module';
import { MasterController } from './master.controller';
import { MasterService } from './master.service';

@Module({ imports: [RightsModule], controllers: [MasterController], providers: [MasterService] })
export class MasterModule {}
