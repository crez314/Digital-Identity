import { Module } from '@nestjs/common';
import { ModelsController } from './models.controller';
import { ModelMetricsService } from './model-metrics.service';

@Module({ controllers: [ModelsController], providers: [ModelMetricsService], exports: [ModelMetricsService] })
export class ModelsModule {}
