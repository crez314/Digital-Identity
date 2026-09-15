import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { assertEncryptionConfig } from '@crez/db';
import { logger } from '@crez/shared';
import { AppModule } from './app.module';
import { assertAuthConfig } from './common/auth/auth-mode';
import { CrezExceptionFilter } from './common/filters/crez-exception.filter';
import { TraceInterceptor } from './common/interceptors/trace.interceptor';

async function bootstrap() {
  // 설정이 잘못되면 요청을 받기 전에 멈춘다(§16) — 인증 모드 누락(fail-open)과 암호화 키 누락.
  // .env는 AppModule을 불러올 때 ConfigModule.forRoot가 이미 process.env에 넣어 두었다.
  const authMode = assertAuthConfig();
  assertEncryptionConfig();

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
  logger.info({ port, authMode }, 'crez-api listening');
}

bootstrap().catch((e) => {
  logger.error({ err: e }, 'bootstrap failed');
  process.exit(1);
});
