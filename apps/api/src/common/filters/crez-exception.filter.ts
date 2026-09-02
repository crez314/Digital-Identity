import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CrezError, ErrorCode, logger } from '@crez/shared';

/** §17 응답 본문은 { code, message, detail, traceId }로 통일한다. */
@Catch()
export class CrezExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const traceId = (req as Request & { traceId?: string }).traceId ?? null;

    if (exception instanceof CrezError) {
      logger.warn({ traceId, code: exception.code, detail: exception.detail }, exception.message);
      return res.status(exception.httpStatus).json(exception.toBody(traceId ?? undefined));
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const code =
        status === HttpStatus.UNAUTHORIZED ? ErrorCode.AUTH_UNAUTHENTICATED
        : status === HttpStatus.FORBIDDEN ? ErrorCode.AUTH_FORBIDDEN
        : status === HttpStatus.NOT_FOUND ? ErrorCode.PRJ_NOT_FOUND
        : ErrorCode.REQ_SCHEMA_INVALID;
      return res.status(status).json({
        code,
        message: typeof body === 'string' ? body : (body as { message?: string }).message ?? exception.message,
        detail: typeof body === 'object' ? body : null,
        traceId,
      });
    }

    logger.error({ traceId, err: exception }, 'unhandled exception');
    return res.status(500).json({
      code: ErrorCode.INTERNAL,
      message: '내부 오류',
      detail: process.env.NODE_ENV === 'production' ? null : String(exception),
      traceId,
    });
  }
}
