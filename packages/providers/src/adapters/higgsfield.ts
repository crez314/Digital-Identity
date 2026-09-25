import {
  CrezError, ErrorCode, HIGGSFIELD_DURATIONS, logger, IDENTITY_NEGATIVE_PROMPT, promptAdherenceFromConditioning,
  snapDuration,
  type ErrorCodeValue,
} from '@crez/shared';
import type {
  FetchResult, GenerationProvider, GenerationRequest, ImagePlan, ModelDescriptor, PollResult, SubmitResult,
} from '../types';
import { planImages } from '../image-plan';

/**
 * Higgsfield 생성 API 어댑터.
 *
 * 계약 출처: 공통 흐름(인증·제출·폴링·취소)은 공식 OpenAPI 스펙(https://docs.higgsfield.ai/docs/openapi.json,
 * v2.0.0)이다. 다만 그 스펙에는 영상 모델이 5개뿐이라, 모델별 요청 필드는 카탈로그의 모드별 input_schema
 * (https://open.higgsfield.ai/models/<경로>/api-reference)에서 가져왔다 — ENDPOINT_SPECS 참고.
 *
 *   인증   Authorization: Key {API_KEY_ID}:{API_KEY_SECRET}   (Bearer 아님)
 *   제출   POST {endpoint}                    → { status, request_id, status_url, cancel_url, video? }
 *   폴링   GET  /requests/{request_id}/status → { status, video: { url }, error }
 *   취소   POST /requests/{request_id}/cancel
 *   상태   queued | in_progress | completed | failed | canceled | nsfw
 *
 * CREZ 관점에서 중요한 두 가지:
 *
 * 1. 레퍼런스 경로(image_urls)가 Identity conditioning에 대응한다. veo3.1은 계정에서 막혔고,
 *    2026-09-22 기준 열린 경로는 seedance 2.5/2.0 reference-to-video, minimax h3 reference-to-video,
 *    kling o3/omni image-reference다.
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
  // model_blocked(423)은 계정에서 그 모델이 막힌 상태다 — 2026-09-18 kling 2.1 계열 3종이 이렇게 돌아왔다.
  // 제공자 장애가 아니라 쓸 수 없는 모델이므로 재시도 대상이 아니다.
  if (d.includes('model_not_found') || d.includes('model_disabled') || d.includes('model_blocked')) {
    return ErrorCode.GEN_NO_CAPABLE_MODEL;
  }
  if (d.includes('credit') || d.includes('quota') || d.includes('balance')) return ErrorCode.GEN_QUOTA_EXCEEDED;
  if (d.includes('nsfw') || d.includes('content_policy') || d.includes('moderation') || d.includes('safety')) {
    return ErrorCode.GEN_CONTENT_POLICY;
  }
  // 402(결제 필요)·429(속도 제한)·5xx·스키마 오류는 전부 제공자 오류로 둔다
  return ErrorCode.GEN_PROVIDER_ERROR;
}

/**
 * 경로별 요청 규격.
 *
 * 모델마다 필드 이름과 표기가 다르다 — 시작 이미지 1장(image_url)인지 레퍼런스 여러 장(image_urls)인지,
 * 길이가 정수인지 문자열인지, 해상도가 '720'·'720p'·'2K' 중 무엇인지, 오디오를 끄는 필드가
 * generate_audio인지 sound인지. 경로 앞부분으로 짐작하면 새 모델이 옛 모델 형식으로 나가 400으로 실패한다.
 * 그래서 경로마다 명시하고, 표에 없는 경로는 제출하지 않는다.
 *
 * 출처: 각 모드의 input_schema — https://open.higgsfield.ai/models/<경로>/api-reference (2026-09-22 조회).
 * 스키마에 없는 필드는 보내지 않는다.
 */
export interface EndpointSpec {
  /** image_url: 시작 이미지 1장. image_urls: 인물 레퍼런스 여러 장(max까지) */
  images: { field: 'image_url' } | { field: 'image_urls'; max: number; perIdentity?: number };
  durationType: 'integer' | 'string';
  /** [세로 픽셀, 스펙 표기] 오름차순. 요청 높이 이상인 가장 작은 값을 쓴다. 없으면 해상도를 보내지 않는다 */
  resolutions?: ReadonlyArray<readonly [number, string]>;
  /** 스펙이 받는 화면 비율. 없으면 보내지 않는다 — 출력이 시작 이미지 비율을 따른다 */
  aspectRatios?: readonly string[];
  /** 스펙의 cfg_scale("프롬프트 준수 강도")로 신원 조건화를 뒤집어 넘긴다 */
  cfgScale?: boolean;
  /** 스펙에 negative_prompt가 있다 — 인물 교체·컷 전환을 한 번 더 막는다 */
  negativePrompt?: boolean;
  /** 고정 필드. 오디오는 별도 파이프라인이라 생성 단계에서 끈다 */
  fixed?: Readonly<Record<string, unknown>>;
}

const VEO_RES = [[720, '720'], [1080, '1080']] as const;
const P_RES = [[720, '720p'], [1080, '1080p']] as const;
const SEEDANCE_25_RES = [[480, '480p'], [720, '720p']] as const;
const SEEDANCE_20_RES = [[480, '480p'], [720, '720p'], [1080, '1080p'], [2160, '4k']] as const;
const WIDE_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const;
const KLING_RATIOS = ['16:9', '9:16', '1:1'] as const;
const H3_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;

const KLING_LEGACY: EndpointSpec = {
  images: { field: 'image_url' }, durationType: 'integer', cfgScale: true, negativePrompt: true,
};
const KLING_V3: EndpointSpec = {
  images: { field: 'image_url' }, durationType: 'integer', cfgScale: true, fixed: { sound: 'off' },
};

export const ENDPOINT_SPECS: Readonly<Record<string, EndpointSpec>> = {
  // reference-to-video — Identity conditioning 경로. veo3.1은 스펙 maxItems=3
  '/veo3.1/reference-to-video': {
    images: { field: 'image_urls', max: 3 }, durationType: 'string', resolutions: VEO_RES,
    aspectRatios: WIDE_RATIOS, fixed: { generate_audio: false },
  },
  '/veo3.1/image-to-video': {
    images: { field: 'image_url' }, durationType: 'string', resolutions: VEO_RES,
    aspectRatios: WIDE_RATIOS, fixed: { generate_audio: false },
  },
  '/veo3.1/fast/image-to-video': {
    images: { field: 'image_url' }, durationType: 'string', resolutions: VEO_RES,
    aspectRatios: WIDE_RATIOS, fixed: { generate_audio: false },
  },
  '/sora-2/image-to-video': { images: { field: 'image_url' }, durationType: 'integer', resolutions: P_RES },

  '/kling-video/v2.1/standard/image-to-video': KLING_LEGACY,
  '/kling-video/v2.1/pro/image-to-video': KLING_LEGACY,
  '/kling-video/v2.1/master/image-to-video': KLING_LEGACY,
  '/kling-video/v2.5-turbo/pro/image-to-video': KLING_LEGACY,
  '/kling-video/v2.5-turbo/standard/image-to-video': KLING_LEGACY,
  '/kling-video/v2.6/pro/image-to-video': {
    images: { field: 'image_url' }, durationType: 'integer', cfgScale: true, aspectRatios: KLING_RATIOS,
    fixed: { sound: 'off' },
  },
  '/kling-video/v3.0/std/image-to-video': KLING_V3,
  '/kling-video/v3.0/pro/image-to-video': KLING_V3,
  '/kling-video/v3.0/4k/image-to-video': KLING_V3,
  '/kling-video/v3.0-turbo/image-to-video': { images: { field: 'image_url' }, durationType: 'integer', resolutions: P_RES },
  // 레퍼런스 장수 상한이 스키마에 없다 — 모르는 상한을 넘겨 400을 받지 않도록 보수적으로 4장
  '/kling-video/o3/image-reference': {
    images: { field: 'image_urls', max: 4, perIdentity: 2 }, durationType: 'integer', aspectRatios: KLING_RATIOS,
    fixed: { sound: 'off' },
  },
  '/kling-video/omni/image-reference': {
    images: { field: 'image_urls', max: 4, perIdentity: 2 }, durationType: 'integer', aspectRatios: KLING_RATIOS,
  },

  '/bytedance/seedance-2.5/image-to-video': {
    images: { field: 'image_url' }, durationType: 'integer', resolutions: SEEDANCE_25_RES,
    fixed: { generate_audio: false },
  },
  '/bytedance/seedance-2.5/reference-to-video': {
    images: { field: 'image_urls', max: 30, perIdentity: 2 }, durationType: 'integer', resolutions: SEEDANCE_25_RES,
    aspectRatios: WIDE_RATIOS, fixed: { generate_audio: false },
  },
  '/bytedance/seedance-2.0/image-to-video': {
    images: { field: 'image_url' }, durationType: 'integer', resolutions: SEEDANCE_20_RES,
    fixed: { generate_audio: false },
  },
  '/bytedance/seedance-2.0/reference-to-video': {
    images: { field: 'image_urls', max: 9, perIdentity: 2 }, durationType: 'integer', resolutions: SEEDANCE_20_RES,
    aspectRatios: WIDE_RATIOS, fixed: { generate_audio: false },
  },

  // H3는 해상도가 '2K' 하나뿐이다
  '/minimax/h3/image-to-video': { images: { field: 'image_url' }, durationType: 'integer', resolutions: [[1440, '2K']] },
  '/minimax/h3/reference-to-video': {
    images: { field: 'image_urls', max: 9, perIdentity: 2 }, durationType: 'integer', resolutions: [[1440, '2K']],
    aspectRatios: H3_RATIOS,
  },
  // prompt_optimizer는 제공자가 프롬프트를 고쳐 쓴다 — CREZ가 넣은 신원 고정 문구가 사라질 수 있어 끈다
  '/minimax/hailuo-2.3/standard/image-to-video': {
    images: { field: 'image_url' }, durationType: 'integer', fixed: { prompt_optimizer: false },
  },
};

function specFor(endpoint: string): EndpointSpec {
  const spec = ENDPOINT_SPECS[endpoint];
  if (!spec) {
    throw new CrezError(
      ErrorCode.GEN_NO_CAPABLE_MODEL,
      `higgsfield: 요청 규격을 모르는 경로 ${endpoint} — adapters/higgsfield.ts의 ENDPOINT_SPECS에 추가해야 한다`,
      { endpoint }, 422,
    );
  }
  return spec;
}

function resolutionValue(spec: EndpointSpec, height: number): string | null {
  const options = spec.resolutions;
  if (!options?.length) return null;
  return (options.find(([h]) => h >= height) ?? options[options.length - 1])[1];
}

function durationFor(endpoint: string, durationMs: number): { value: number; snapped: boolean } {
  const options = HIGGSFIELD_DURATIONS[endpoint];
  if (!options) {
    throw new CrezError(ErrorCode.GEN_NO_CAPABLE_MODEL, `higgsfield: 허용 길이를 모르는 경로 ${endpoint}`, { endpoint }, 422);
  }
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
   * 제출할 이미지 배분. 레퍼런스 경로는 스펙의 image_urls 상한까지, image-to-video는 시작 이미지 1장이다.
   * 인물 얼굴을 먼저 한 장씩 넣고 남는 자리에 배경·의상·헤어 참고 이미지를 넣는다(image-plan.ts).
   */
  planImages(req: GenerationRequest): ImagePlan {
    const { images } = specFor(this.cfg.endpoint);
    if (images.field !== 'image_urls') return planImages(req, 1);
    return planImages(req, images.max, { perIdentity: images.perIdentity });
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
    const spec = specFor(ep);
    const { value: duration, snapped } = durationFor(ep, req.durationMs);
    if (snapped) {
      logger.warn(
        { segmentId: req.segmentId, requestedMs: req.durationMs, providerSeconds: duration, endpoint: ep },
        'higgsfield: 세그먼트 길이를 제공자 허용 길이로 스냅했다',
      );
    }

    const body: Record<string, unknown> = { prompt: req.prompt ?? '' };
    if (spec.images.field === 'image_urls') {
      // 레퍼런스 경로 — Identity conditioning
      body.image_urls = this.plannedUrls(req, '레퍼런스 경로에는 인물 레퍼런스 이미지가 최소 1장 필요하다');
    } else {
      // image-to-video — 시작 프레임 1장. 참고 이미지를 받을 자리가 없어 전부 dropped로 기록된다
      body.image_url = this.plannedUrls(req, 'image-to-video에는 인물 시작 이미지가 필요하다')[0];
    }
    body.duration = spec.durationType === 'string' ? String(duration) : duration;

    const resolution = resolutionValue(spec, req.resolution);
    if (resolution !== null) body.resolution = resolution;

    if (spec.aspectRatios?.includes(req.aspectRatio)) {
      body.aspect_ratio = req.aspectRatio;
    } else {
      // 비율 파라미터가 없거나 이 비율을 받지 않는 모델 — 출력이 시작 이미지(또는 제공자 기본) 비율을 따른다.
      // 얼굴 위주 레퍼런스를 쓰면 정사각형에 가까운 영상이 나오므로 조용히 넘기지 않는다.
      logger.warn(
        { segmentId: req.segmentId, endpoint: ep, requested: req.aspectRatio, supported: spec.aspectRatios ?? null },
        'higgsfield: 이 모델은 요청한 화면 비율을 지정할 수 없다 — 시작 이미지 비율을 따른다',
      );
    }

    if (spec.cfgScale) {
      // 스펙상 cfg_scale은 "프롬프트 준수 강도"(0~1, 기본 0.5)다. 값이 높을수록 텍스트를 따라가며
      // 시작 이미지에서 멀어지므로, 신원 조건화 강도를 뒤집어 넘긴다 (prompt-identity.ts).
      body.cfg_scale = promptAdherenceFromConditioning(req.conditioningStrength);
    }
    if (spec.negativePrompt) body.negative_prompt = IDENTITY_NEGATIVE_PROMPT;
    return { ...body, ...spec.fixed };
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
