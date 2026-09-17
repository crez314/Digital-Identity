import {
  CrezError, ErrorCode, logger, IDENTITY_NEGATIVE_PROMPT, promptAdherenceFromConditioning, snapDuration,
  type ErrorCodeValue,
} from '@crez/shared';
import type {
  FetchResult, GenerationProvider, GenerationRequest, ImagePlan, ModelDescriptor, PollResult, SubmitResult,
} from '../types';
import { planImages } from '../image-plan';

/**
 * Higgsfield 생성 API 어댑터.
 *
 * 계약 출처는 공식 OpenAPI 스펙(https://docs.higgsfield.ai/docs/openapi.json, v2.0.0)이며,
 * 이 파일의 필드명·enum·경로는 전부 그 스펙에서 그대로 가져왔다. 추정한 값은 없다.
 *
 *   인증   Authorization: Key {API_KEY_ID}:{API_KEY_SECRET}   (Bearer 아님)
 *   제출   POST {endpoint}                    → { status, request_id, status_url, cancel_url, video? }
 *   폴링   GET  /requests/{request_id}/status → { status, video: { url }, error }
 *   취소   POST /requests/{request_id}/cancel
 *   상태   queued | in_progress | completed | failed | canceled | nsfw
 *
 * CREZ 관점에서 중요한 두 가지:
 *
 * 1. `/veo3.1/reference-to-video`가 레퍼런스 이미지 1~3장을 받는다. 이것이 Identity
 *    conditioning에 대응하는 유일한 상용 경로이므로 기본 경로로 삼는다.
 * 2. 상태 enum에 `nsfw`가 따로 있다. 콘텐츠 정책 거부는 재시도 대상이 아니므로(§8)
 *    CREZ-GEN-003으로 매핑해 재시도 루프에 들어가지 않게 한다.
 */

/** OpenAPI의 status enum 그대로 */
type HfStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'canceled' | 'nsfw';

interface HfMedia { url: string }

interface HfRequest {
  status: HfStatus;
  request_id: string;
  status_url?: string;
  cancel_url?: string;
  error?: string | null;
  video?: HfMedia | null;
  images?: HfMedia[];
}

export interface HiggsfieldConfig {
  /** 모델 code → 제출 엔드포인트 경로. 예: '/veo3.1/reference-to-video' */
  endpoint: string;
  baseUrl?: string;
  keyId?: string;
  keySecret?: string;
  timeoutMs?: number;
}

/**
 * 제공자 오류를 CREZ 에러 코드로 옮긴다.
 *
 * v1.3까지는 재시도 대상이 아닌 4xx를 전부 CREZ-GEN-003(콘텐츠 정책)으로 기록했다. 그래서
 * `404 model_not_found`(계정에 그 모델이 없음)가 "부적절한 콘텐츠로 거부됨"으로 남아 원인을 잘못 짚게 했다 —
 * 2026-09-16 veo3.1 reference-to-video 실패가 실제로 그렇게 기록됐다.
 * 상태 코드는 같은 사유에도 404·503으로 갈리므로 detail 문자열로 판정한다.
 */
export function classifyHiggsfieldError(detail: string): ErrorCodeValue {
  const d = detail.toLowerCase();
  if (d.includes('model_not_found') || d.includes('model_disabled')) return ErrorCode.GEN_NO_CAPABLE_MODEL;
  if (d.includes('credit') || d.includes('quota') || d.includes('balance')) return ErrorCode.GEN_QUOTA_EXCEEDED;
  if (d.includes('nsfw') || d.includes('content_policy') || d.includes('moderation') || d.includes('safety')) {
    return ErrorCode.GEN_CONTENT_POLICY;
  }
  // 402(결제 필요)·429(속도 제한)·5xx·스키마 오류는 전부 제공자 오류로 둔다
  return ErrorCode.GEN_PROVIDER_ERROR;
}

/** 스펙상 duration은 임의 값이 아니라 고정 enum이다. 경로별 허용 목록. */
const DURATION_OPTIONS: Record<string, number[]> = {
  'veo3.1': [4, 6, 8],
  kling: [5, 10],
  'sora-2': [4, 8, 12],
  minimax: [6, 10],
  'wan-25': [5, 10],
  seedance: [4, 8, 12],
};

/** 해상도도 경로별로 표기가 다르다('720' vs '720p'). 스펙 표기를 그대로 쓴다. */
function resolutionValue(endpoint: string, height: number): string {
  const target = height >= 1080 ? 1080 : 720;
  if (endpoint.startsWith('/veo3.1')) return String(target);            // '720' | '1080'
  if (endpoint.startsWith('/sora-2')) return `${target}p`;              // '720p' | '1080p'
  if (endpoint.startsWith('/wan-25')) return `${target}p`;
  if (endpoint.startsWith('/bytedance')) return String(target);         // '480' | '720' | '1080'
  return `${target}p`;
}

function durationFor(endpoint: string, durationMs: number): { value: number; snapped: boolean } {
  const family = Object.keys(DURATION_OPTIONS).find((k) => endpoint.includes(k)) ?? 'veo3.1';
  const options = DURATION_OPTIONS[family];
  const wanted = durationMs / 1000;
  // 세그먼트 길이는 임의값이지만 제공자는 고정 길이만 받는다. 가장 가까운 값으로 맞추고
  // 그 사실을 호출자에게 알린다 — 조용히 길이가 바뀌면 QC 시계열이 소스와 어긋난다.
  // 맞추는 규칙은 비용 견적과 공유한다(@crez/shared). 둘이 어긋나면 상한이 제 역할을 못 한다.
  const value = snapDuration(options, wanted);
  return { value, snapped: Math.abs(value - wanted) > 0.01 };
}

export class HiggsfieldProvider implements GenerationProvider {
  readonly code: string;

  constructor(code: string, private readonly cfg: HiggsfieldConfig) {
    this.code = code;
  }

  private get baseUrl(): string {
    return (this.cfg.baseUrl ?? process.env.HIGGSFIELD_BASE_URL ?? 'https://api.higgsfield.ai').replace(/\/$/, '');
  }

  private authHeader(): string {
    const id = this.cfg.keyId ?? process.env.HIGGSFIELD_KEY_ID ?? '';
    const secret = this.cfg.keySecret ?? process.env.HIGGSFIELD_KEY_SECRET ?? '';
    if (!id || !secret) {
      throw new CrezError(
        ErrorCode.GEN_PROVIDER_ERROR,
        'HIGGSFIELD_KEY_ID / HIGGSFIELD_KEY_SECRET 미설정',
        null, 500,
      );
    }
    return `Key ${id}:${secret}`;
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 60000);
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          authorization: this.authHeader(),
          ...(init.headers ?? {}),
        },
      });
      const text = await res.text();
      const body: unknown = text ? JSON.parse(text) : {};
      if (!res.ok) {
        // 스펙의 에러 본문은 { detail: string }
        const detail = (body as { detail?: string }).detail ?? text.slice(0, 500);
        throw new CrezError(
          classifyHiggsfieldError(detail),
          `higgsfield ${res.status}: ${detail}`,
          { status: res.status, detail, path },
          502,
        );
      }
      return body as T;
    } catch (e) {
      if (e instanceof CrezError) throw e;
      throw new CrezError(ErrorCode.GEN_PROVIDER_ERROR, 'higgsfield 전송 오류', String(e), 502);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 제출할 이미지 배분. reference-to-video는 스펙상 image_urls 최대 3장, image-to-video는 시작 이미지 1장이다.
   * 인물 얼굴을 먼저 한 장씩 넣고 남는 자리에 배경·의상·헤어 참고 이미지를 넣는다(image-plan.ts).
   */
  planImages(req: GenerationRequest): ImagePlan {
    return planImages(req, this.cfg.endpoint.includes('reference-to-video') ? 3 : 1);
  }

  /** 신원 레퍼런스 없이 참고 이미지만으로 제출하면 인물이 보장되지 않으므로 거절한다 */
  private plannedUrls(req: GenerationRequest, what: string): string[] {
    const plan = this.planImages(req);
    if (!plan.images.some((i) => i.role === 'IDENTITY')) {
      throw new CrezError(ErrorCode.GEN_PROVIDER_ERROR, what, { segmentId: req.segmentId }, 422);
    }
    return plan.images.map((i) => i.url);
  }

  private buildBody(req: GenerationRequest): Record<string, unknown> {
    const ep = this.cfg.endpoint;
    const { value: duration, snapped } = durationFor(ep, req.durationMs);
    if (snapped) {
      logger.warn(
        { segmentId: req.segmentId, requestedMs: req.durationMs, providerSeconds: duration, endpoint: ep },
        'higgsfield: 세그먼트 길이를 제공자 허용 길이로 스냅했다',
      );
    }
    const aspect = req.aspectRatio;
    const prompt = req.prompt ?? '';

    // reference-to-video — Identity conditioning 경로
    if (ep.includes('reference-to-video')) {
      const urls = this.plannedUrls(req, 'reference-to-video에는 인물 레퍼런스 이미지가 최소 1장 필요하다'); // 스펙 maxItems=3
      return {
        prompt,
        image_urls: urls,
        duration: String(duration),                      // veo3.1은 문자열 enum
        resolution: resolutionValue(ep, req.resolution),
        aspect_ratio: aspect,
        generate_audio: false,                            // 오디오는 별도 파이프라인
      };
    }

    // image-to-video — 시작 프레임 1장. 참고 이미지를 받을 자리가 없어 전부 dropped로 기록된다
    const [first] = this.plannedUrls(req, 'image-to-video에는 인물 시작 이미지가 필요하다');
    const body: Record<string, unknown> = { prompt, image_url: first };
    if (ep.startsWith('/veo3.1')) {
      body.duration = String(duration);
      body.resolution = resolutionValue(ep, req.resolution);
      body.aspect_ratio = aspect;
      body.generate_audio = false;
    } else if (ep.includes('kling')) {
      body.duration = duration;                           // kling은 정수
      // 스펙상 cfg_scale은 "프롬프트 준수 강도"(0~1, 기본 0.5)다. 값이 높을수록 텍스트를 따라가며
      // 시작 이미지에서 멀어지므로, 신원 조건화 강도를 뒤집어 넘긴다 (prompt-identity.ts).
      body.cfg_scale = promptAdherenceFromConditioning(req.conditioningStrength);
      // 스펙에 negative_prompt가 있다. 인물 교체·컷 전환을 여기서 한 번 더 막는다.
      body.negative_prompt = IDENTITY_NEGATIVE_PROMPT;
      // kling 스펙에는 화면 비율 파라미터가 없다 — 출력이 시작 이미지 비율을 그대로 따른다.
      // 얼굴 위주 레퍼런스를 쓰면 정사각형에 가까운 영상이 나오므로 조용히 넘기지 않는다.
      logger.warn(
        { segmentId: req.segmentId, endpoint: ep, requested: req.aspectRatio },
        'higgsfield: 이 모델은 화면 비율을 지정할 수 없다 — 시작 이미지 비율을 따른다',
      );
    } else {
      body.duration = duration;
      body.resolution = resolutionValue(ep, req.resolution);
    }
    return body;
  }

  async submit(req: GenerationRequest, _model?: ModelDescriptor): Promise<SubmitResult> {
    const body = this.buildBody(req);
    const res = await this.call<HfRequest>(this.cfg.endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.request_id) {
      throw new CrezError(ErrorCode.GEN_PROVIDER_ERROR, 'higgsfield 응답에 request_id 없음', res, 502);
    }
    logger.info(
      { segmentId: req.segmentId, requestId: res.request_id, endpoint: this.cfg.endpoint, status: res.status },
      'higgsfield 제출 완료',
    );
    return { providerJobId: res.request_id };
  }

  async poll(providerJobId: string, _model?: ModelDescriptor): Promise<PollResult> {
    const res = await this.call<HfRequest>(`/requests/${providerJobId}/status`, { method: 'GET' });
    return mapStatus(res);
  }

  async fetchResult(providerJobId: string, req: GenerationRequest, model: ModelDescriptor): Promise<FetchResult> {
    const res = await this.call<HfRequest>(`/requests/${providerJobId}/status`, { method: 'GET' });
    const url = res.video?.url;
    if (!url) {
      throw new CrezError(
        ErrorCode.GEN_PROVIDER_ERROR,
        `higgsfield 완료 응답에 video.url이 없다 (status=${res.status})`,
        res, 502,
      );
    }
    const { value: seconds } = durationFor(this.cfg.endpoint, req.durationMs);
    const height = req.resolution >= 1080 ? 1080 : 720;

    // storageKey에 제공자 URL을 담아 돌려주면 워커가 내려받아 §15 레이아웃 키로 실체화한다.
    return {
      storageKey: url,
      durationMs: seconds * 1000,
      fps: req.fps,
      width: Math.round((height * 16) / 9),
      height,
      costAmount: this.estimateCost(req, model),
    };
  }

  async cancel(providerJobId: string, _model?: ModelDescriptor): Promise<void> {
    await this.call(`/requests/${providerJobId}/cancel`, { method: 'POST' });
  }

  estimateCost(req: GenerationRequest, model: ModelDescriptor): number {
    const { value: seconds } = durationFor(this.cfg.endpoint, req.durationMs);
    const perSecond = model?.costPerSecond ?? 0;  // 계약 단가 미확정 시 0
    return Number((seconds * perSecond).toFixed(4));
  }
}

/** 상태 매핑을 순수 함수로 분리해 테스트 가능하게 둔다. */
export function mapStatus(res: HfRequest): PollResult {
  switch (res.status) {
    case 'completed':
      return { state: 'SUCCEEDED', progress: 1 };
    case 'canceled':
      return { state: 'CANCELLED', progress: 0 };
    case 'nsfw':
      // 콘텐츠 정책 거부는 재시도해도 같은 결과다 (§8)
      return {
        state: 'FAILED', progress: 1,
        errorCode: ErrorCode.GEN_CONTENT_POLICY,
        errorDetail: res.error ?? 'higgsfield: nsfw로 거부됨',
      };
    case 'failed':
      return {
        state: 'FAILED', progress: 1,
        errorCode: ErrorCode.GEN_PROVIDER_ERROR,
        errorDetail: res.error ?? 'higgsfield: 생성 실패',
      };
    case 'queued':
      return { state: 'RUNNING', progress: 0.05, nextPollMs: 5000 };
    case 'in_progress':
    default:
      return { state: 'RUNNING', progress: 0.5, nextPollMs: 5000 };
  }
}

/** ai_model.code → Higgsfield 엔드포인트. 라우터가 고른 모델을 실제 경로로 옮긴다. */
export const HIGGSFIELD_ENDPOINTS: Record<string, string> = {
  'higgsfield-veo31-reference': '/veo3.1/reference-to-video',
  'higgsfield-veo31-i2v': '/veo3.1/image-to-video',
  'higgsfield-veo31-fast-i2v': '/veo3.1/fast/image-to-video',
  'higgsfield-kling25-pro-i2v': '/kling-video/v2.5-turbo/pro/image-to-video',
  'higgsfield-sora2-i2v': '/sora-2/image-to-video',
};
