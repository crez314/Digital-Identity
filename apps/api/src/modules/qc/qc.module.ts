import { Module } from '@nestjs/common';
import { ProjectModule } from '../project/project.module';
import { QcController } from './qc.controller';
import { QcService } from './qc.service';

@Module({
  imports: [ProjectModule],
  controllers: [QcController],
  providers: [QcService],
  exports: [QcService],
})
export class QcModule {}
