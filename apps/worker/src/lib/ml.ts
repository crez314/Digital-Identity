import type { ZodType } from 'zod';
import { Ml } from '@crez/contracts';
import { CrezError, ErrorCode, logger } from '@crez/shared';

/** 워커용 crez-ml 클라이언트 (§7). api의 것과 동일 계약을 사용한다. */
const baseUrl = () => process.env.ML_BASE_URL ?? 'http://localhost:8000';

async function post<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.ML_TIMEOUT_MS ?? 600000));
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-internal-token': process.env.ML_INTERNAL_TOKEN ?? '' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new CrezError(ErrorCode.ML_UNAVAILABLE, `crez-ml ${path} → ${res.status}`, text.slice(0, 1000), 502);
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) {
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

export const ml = {
  embedFace: (r: Ml.EmbedFaceRequest) => post('/v1/embed/face', r, Ml.EmbedFaceResponse),
  embedBody: (r: Ml.EmbedBodyRequest) => post('/v1/embed/body', r, Ml.EmbedBodyResponse),
  aggregate: (r: Ml.AggregateRequest) => post('/v1/profile/aggregate', r, Ml.AggregateResponse),
  analyzeVideo: (r: Ml.VideoAnalyzeRequest) => post('/v1/video/analyze', r, Ml.VideoAnalyzeResponse),
  assignIdentity: (r: Ml.IdentityAssignRequest) => post('/v1/identity/assign', r, Ml.IdentityAssignResponse),
  scoreQc: (r: Ml.QcScoreRequest) => post('/v1/qc/score', r, Ml.QcScoreResponse),
  detectArtifacts: (r: Ml.QcArtifactRequest) => post('/v1/qc/artifact', r, Ml.QcArtifactResponse),
  extractFrames: (r: Ml.ExtractFramesRequest) => post('/v1/media/frames', r, Ml.ExtractFramesResponse),
};
