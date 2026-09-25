import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { logger, newTraceId } from '@crez/shared';

/** §8: 생성 job 단위 trace ID 전파 필수. HTTP 진입점에서 만들어 job payload까지 넘긴다. */
@Injectable()
export class TraceInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request & { traceId?: string }>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const traceId = (req.headers['x-trace-id'] as string) || newTraceId();
    req.traceId = traceId;
    // SSE(@Sse)에서는 이 인터셉터가 돌 때 이미 200과 스트림 헤더가 나간 뒤다 — Nest가 인터셉터 체인을
    // 구독 시점에 실행하는데, 그 전에 SseStream이 헤더를 쓴다. 그 상태에서 헤더를 달면 예외가 나고
    // Nest는 그 예외를 error 이벤트로 흘려 스트림을 즉시 끊는다. 실시간 진행 표시가 브라우저에서
    // 한 번도 연결되지 않던(‘연결 대기’에서 멈추던) 원인이다.
    if (!res.headersSent) res.setHeader('x-trace-id', traceId);

    const startedAt = Date.now();
    return next.handle().pipe(
      tap({
        next: () => logger.debug({ traceId, method: req.method, path: req.path, ms: Date.now() - startedAt }, 'request'),
        error: (err) => logger.warn({ traceId, method: req.method, path: req.path, err: String(err) }, 'request failed'),
      }),
    );
  }
}
