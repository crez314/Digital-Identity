import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { logger } from '@crez/shared';
import { AppModule } from './app.module';
import { CrezExceptionFilter } from './common/filters/crez-exception.filter';
import { TraceInterceptor } from './common/interceptors/trace.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.setGlobalPrefix('api/v1'); // §6 Base path
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? '*' });
  app.useGlobalFilters(new CrezExceptionFilter());
  app.useGlobalInterceptors(new TraceInterceptor());

  // §1.1 NestJS를 고른 이유 중 하나 — OpenAPI 자동 생성
  const config = new DocumentBuilder()
    .setTitle('CREZ Digital Identity Content Engine API')
    .setDescription('기술명세서 v1.1 §6 API 명세')
    .setVersion('1.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  logger.info({ port }, 'crez-api listening');
}

bootstrap().catch((e) => {
  logger.error({ err: e }, 'bootstrap failed');
  process.exit(1);
});
