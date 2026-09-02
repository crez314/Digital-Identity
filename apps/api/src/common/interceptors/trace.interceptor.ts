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
    res.setHeader('x-trace-id', traceId);

    const startedAt = Date.now();
    return next.handle().pipe(
      tap({
        next: () => logger.debug({ traceId, method: req.method, path: req.path, ms: Date.now() - startedAt }, 'request'),
        error: (err) => logger.warn({ traceId, method: req.method, path: req.path, err: String(err) }, 'request failed'),
      }),
    );
  }
}
