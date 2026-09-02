import { Injectable } from '@nestjs/common';
import { CrezError, ErrorCode, logger } from '@crez/shared';
import type { ZodType } from 'zod';
import { Ml } from '@crez/contracts';

/**
 * §7 crez-ml 호출 클라이언트.
 * crez-ml은 stateless이며 판단하지 않는다. 여기서는 계약 검증만 하고
 * 임계값 적용은 QC 규칙 엔진(@crez/engine)이 담당한다.
 */
@Injectable()
export class MlClient {
  private get baseUrl(): string {
    return process.env.ML_BASE_URL ?? 'http://localhost:8000';
  }

  private async post<TReq, TRes>(path: string, body: TReq, schema: ZodType<TRes>): Promise<TRes> {
    const ctrl = new AbortController();
    const timeoutMs = Number(process.env.ML_TIMEOUT_MS ?? 600000);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-internal-token': process.env.ML_INTERNAL_TOKEN ?? '',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new CrezError(ErrorCode.ML_UNAVAILABLE, `crez-ml ${path} → ${res.status}`, text.slice(0, 2000), 502);
      }
      const parsed = schema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        // 계약 불일치는 연결 실패와 원인이 전혀 다르다. 섞어서 보고하면 진단이 어긋난다.
        throw new CrezError(
          ErrorCode.INTERNAL,
          `crez-ml ${path} 응답이 contracts 스키마와 불일치합니다`,
          parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
          502,
        );
      }
      return parsed.data;
    } catch (e) {
      if (e instanceof CrezError) throw e;
      logger.error({ path, err: String(e) }, 'ml call failed');
      throw new CrezError(ErrorCode.ML_UNAVAILABLE, `crez-ml ${path} 호출 실패`, String(e), 502);
    } finally {
      clearTimeout(timer);
    }
  }

  embedFace(req: Ml.EmbedFaceRequest) {
    return this.post('/v1/embed/face', req, Ml.EmbedFaceResponse);
  }
  embedBody(req: Ml.EmbedBodyRequest) {
    return this.post('/v1/embed/body', req, Ml.EmbedBodyResponse);
  }
  aggregate(req: Ml.AggregateRequest) {
    return this.post('/v1/profile/aggregate', req, Ml.AggregateResponse);
  }
  analyzeVideo(req: Ml.VideoAnalyzeRequest) {
    return this.post('/v1/video/analyze', req, Ml.VideoAnalyzeResponse);
  }
  assignIdentity(req: Ml.IdentityAssignRequest) {
    return this.post('/v1/identity/assign', req, Ml.IdentityAssignResponse);
  }
  scoreQc(req: Ml.QcScoreRequest) {
    return this.post('/v1/qc/score', req, Ml.QcScoreResponse);
  }
  detectArtifacts(req: Ml.QcArtifactRequest) {
    return this.post('/v1/qc/artifact', req, Ml.QcArtifactResponse);
  }
  extractFrames(req: Ml.ExtractFramesRequest) {
    return this.post('/v1/media/frames', req, Ml.ExtractFramesResponse);
  }

  async health(): Promise<{ ok: boolean; mode?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as Record<string, unknown>;
      return { ok: true, mode: typeof body.mode === 'string' ? body.mode : undefined };
    } catch {
      return { ok: false };
    }
  }
}
