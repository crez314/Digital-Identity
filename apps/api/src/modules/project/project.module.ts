import { Module } from '@nestjs/common';
import { RightsModule } from '../rights/rights.module';
import { SpendModule } from '../spend/spend.module';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';
import { GenerationService } from './generation.service';

@Module({
  imports: [RightsModule, SpendModule],
  controllers: [ProjectController],
  providers: [ProjectService, GenerationService],
  exports: [ProjectService, GenerationService],
})
export class ProjectModule {}
