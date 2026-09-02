import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';
import { CrezError, ErrorCode } from '@crez/shared';

/** contracts의 zod 스키마를 그대로 요청 검증에 쓴다 (§3 단일 출처) */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new CrezError(
        ErrorCode.REQ_SCHEMA_INVALID,
        undefined,
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        422,
      );
    }
    return result.data;
  }
}
