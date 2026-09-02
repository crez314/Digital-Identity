import { Module } from '@nestjs/common';
import { RightsController } from './rights.controller';
import { RightsService } from './rights.service';

@Module({ controllers: [RightsController], providers: [RightsService], exports: [RightsService] })
export class RightsModule {}
