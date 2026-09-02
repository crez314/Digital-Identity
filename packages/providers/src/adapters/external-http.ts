import { CrezError, ErrorCode } from '@crez/shared';
import type {
  FetchResult, GenerationProvider, GenerationRequest, ModelDescriptor, PollResult, SubmitResult,
} from '../types';

/**
 * 외부 상용 생성 API 어댑터 (§1 하이브리드, §12).
 * 대부분의 제공자가 비동기 폴링이므로 submit → provider_job_id 저장 → 지연 폴링 구조를 따른다(§8).
 *
 * 제공자별 요청/응답 형태는 다르므로 매핑 함수만 교체해서 재사용한다.
 * 계약 확정 전까지 엔드포인트 스키마는 이 어댑터의 기본형을 따른다(§22 미결정: 외부 API 우선순위).
 */
export interface ExternalHttpConfig {
  code: string;
  baseUrl: string;
  apiKey: string;
  /** 콘텐츠 정책 거부를 나타내는 제공자 에러 코드 — 재시도 대상이 아님 (§8, CREZ-GEN-003) */
  contentPolicyCodes?: string[];
  timeoutMs?: number;
}

export class ExternalHttpProvider implements GenerationProvider {
  readonly code: string;
  constructor(private readonly cfg: ExternalHttpConfig) {
    this.code = cfg.code;
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30000);
    try {
      const res = await fetch(`${this.cfg.baseUrl}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
          ...(init.headers ?? {}),
        },
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const providerCode = String(body?.code ?? res.status);
        const isPolicy = this.cfg.contentPolicyCodes?.includes(providerCode) || res.status === 422;
        throw new CrezError(
          isPolicy ? ErrorCode.GEN_CONTENT_POLICY : ErrorCode.GEN_PROVIDER_ERROR,
          `provider ${this.code} responded ${res.status}`,
          body,
          502,
        );
      }
      return body as T;
    } catch (e) {
      if (e instanceof CrezError) throw e;
      throw new CrezError(ErrorCode.GEN_PROVIDER_ERROR, `provider ${this.code} transport error`, String(e), 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async submit(req: GenerationRequest, model: ModelDescriptor): Promise<SubmitResult> {
    const body = {
      model: model.code,
      mode: req.mode,
      durationMs: req.durationMs,
      fps: req.fps,
      resolution: req.resolution,
      prompt: req.prompt,
      seed: req.seed,
      identityConditioning: {
        strength: req.conditioningStrength,
        subjects: req.cast.map((c) => ({
          slot: c.slotIndex,
          appearance: c.appearance,
          referenceKeys: c.references.map((r) => r.storageKey),
        })),
      },
      sourceVideoKey: req.sourceVideoKey,
      poseTracksKey: req.sourceTracksKey,
      callbackTraceId: req.traceId,
    };
    const res = await this.call<{ jobId: string }>('/v1/jobs', { method: 'POST', body: JSON.stringify(body) });
    return { providerJobId: res.jobId };
  }

  async poll(providerJobId: string): Promise<PollResult> {
    const res = await this.call<{ status: string; progress?: number; error?: { code: string; detail?: unknown } }>(
      `/v1/jobs/${providerJobId}`, { method: 'GET' },
    );
    const map: Record<string, PollResult['state']> = {
      queued: 'RUNNING', running: 'RUNNING', processing: 'RUNNING',
      succeeded: 'SUCCEEDED', completed: 'SUCCEEDED',
      failed: 'FAILED', error: 'FAILED', cancelled: 'CANCELLED',
    };
    const state = map[res.status?.toLowerCase()] ?? 'RUNNING';
    const isPolicy = res.error && this.cfg.contentPolicyCodes?.includes(res.error.code);
    return {
      state,
      progress: res.progress ?? (state === 'SUCCEEDED' ? 1 : 0),
      errorCode: res.error ? (isPolicy ? ErrorCode.GEN_CONTENT_POLICY : ErrorCode.GEN_PROVIDER_ERROR) : undefined,
      errorDetail: res.error?.detail,
      nextPollMs: 5000,
    };
  }

  async fetchResult(providerJobId: string, req: GenerationRequest, model: ModelDescriptor): Promise<FetchResult> {
    const res = await this.call<{
      outputUrl: string; durationMs: number; fps: number; width: number; height: number; cost?: number;
    }>(`/v1/jobs/${providerJobId}/result`, { method: 'GET' });
    // 실제 다운로드·S3 업로드는 워커의 media 유틸이 담당한다(어댑터는 위치만 알려준다).
    return {
      storageKey: res.outputUrl,
      durationMs: res.durationMs,
      fps: res.fps,
      width: res.width,
      height: res.height,
      costAmount: res.cost ?? this.estimateCost(req, model),
    };
  }

  async cancel(providerJobId: string): Promise<void> {
    await this.call(`/v1/jobs/${providerJobId}/cancel`, { method: 'POST' });
  }

  estimateCost(req: GenerationRequest, model: ModelDescriptor): number {
    return Number(((req.durationMs / 1000) * (model.costPerSecond || 0)).toFixed(4));
  }
}
