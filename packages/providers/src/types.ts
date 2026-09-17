import type { GenerationMode } from '@crez/contracts';

/**
 * §12: 외부 API와 자체 호스팅 모델이 동일한 인터페이스를 구현한다.
 * 하이브리드 전환 비용을 어댑터 한 개 추가로 끝내기 위한 계약.
 */

export interface ModelCapabilities {
  maxDurationMs: number;
  maxPersons: number;
  modes: GenerationMode[];
  maxResolution: number; // 세로 픽셀 (1080 = 1080p)
}

/** §12 과거 QC 결과에서 역산한 실측치 */
export interface ModelMetrics {
  identityScore: number;
  motionScore: number;
  qualityScore: number;
  avgLatencyMs: number;
  failureRate: number;
  regenRate: number;
}

export interface ModelDescriptor {
  id: string;
  code: string;
  provider: 'EXTERNAL_API' | 'SELF_HOSTED';
  endpoint: string | null;
  capabilities: ModelCapabilities;
  costPerSecond: number;
  status: string;
  metrics: Partial<ModelMetrics>;
}

/** 레퍼런스 자산 — 재생성 전략 2단계에서 교체 대상 (§11) */
export interface ReferenceAsset {
  identityId: string;
  assetId: string;
  storageKey: string;
  /**
   * 외부 제공자가 내려받을 수 있는 presigned URL.
   * 상용 API 대부분이 공개 URL만 받으므로 워커가 제출 직전에 채운다.
   * 버킷은 비공개를 유지하고 만료 시간이 붙은 URL만 밖으로 나간다(§15).
   */
  signedUrl: string | null;
  captureSlot: string | null;
  expression: string | null;
  quality: number | null;
  /**
   * 이 인물의 대표 이미지로 먼저 쓴다. image-to-video에서는 이것이 곧 시작 프레임이다.
   * 워커가 구간마다 다른 사진을 대표로 세워 컷이 전부 같은 장면에서 시작하는 것을 막는다(§5.1).
   * 지정이 없으면 기존대로 품질 순으로 고른다.
   */
  lead?: boolean;
}

/** 세그먼트 프롬프트에 붙인 참고 이미지 — 배경·의상·헤어 */
export interface PromptAttachment {
  referenceId: string;
  kind: 'BACKGROUND' | 'OUTFIT' | 'HAIR';
  /** 의상·헤어가 속한 캐스트 위치. 배경이나 전원 공통이면 null */
  slotIndex: number | null;
  storageKey: string;
  /** 외부 제공자용 presigned URL — ReferenceAsset.signedUrl과 같은 규칙 */
  signedUrl: string | null;
}

/** 제공자에 실제로 넘기는 이미지 한 장과 그 역할 */
export interface PlannedImage {
  role: 'IDENTITY' | PromptAttachment['kind'];
  url: string;
  slotIndex: number | null;
  identityId?: string;
  assetId?: string;
  referenceId?: string;
}

/** 이미지 배분 결과. 한도를 넘어 빠진 첨부는 생성 기록에 남겨 사용자에게 보여준다 */
export interface ImagePlan {
  images: PlannedImage[];
  droppedReferenceIds: string[];
}

export interface GenerationRequest {
  traceId: string;
  segmentId: string;
  attempt: number;
  durationMs: number;
  fps: number;
  resolution: number;
  mode: GenerationMode;
  prompt: string | null;
  seed: number | null;
  /** identity conditioning 강도 — 재생성 1단계에서 상향 (§11) */
  conditioningStrength: number;
  cast: Array<{
    identityId: string;
    profileId: string;
    slotIndex: number;
    appearance: Record<string, unknown>;
    references: ReferenceAsset[];
  }>;
  /** 프롬프트 참고 이미지(배경·의상·헤어). 인물 신원 레퍼런스와 함께 제공자 이미지 한도 안에서 배분된다 */
  attachments: PromptAttachment[];
  /** 출력 화면 비율 (project.config.aspectRatio, 기본 16:9). 받지 않는 제공자는 무시하고 경고를 남긴다 */
  aspectRatio: '16:9' | '9:16';
  /** pose-guided 모드용 소스 트랙 키 */
  sourceVideoKey: string | null;
  sourceTracksKey: string | null;
  outputKey: string;
}

export interface SubmitResult {
  providerJobId: string;
  /** 제출 즉시 결과가 나온 경우(동기 모델) */
  immediate?: FetchResult;
}

export type PollState = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface PollResult {
  state: PollState;
  progress: number; // 0..1
  errorCode?: string;
  errorDetail?: unknown;
  /** 다음 폴링까지 권장 지연 */
  nextPollMs?: number;
}

export interface FetchResult {
  storageKey: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  costAmount: number;
}

export interface GenerationProvider {
  readonly code: string;
  /** 이 제공자에 넘길 이미지와 빠지는 첨부를 계산한다. submit이 쓰는 것과 같은 결과여야 한다 */
  planImages(req: GenerationRequest): ImagePlan;
  submit(req: GenerationRequest, model: ModelDescriptor): Promise<SubmitResult>;
  poll(providerJobId: string, model: ModelDescriptor): Promise<PollResult>;
  fetchResult(providerJobId: string, req: GenerationRequest, model: ModelDescriptor): Promise<FetchResult>;
  cancel(providerJobId: string, model: ModelDescriptor): Promise<void>;
  estimateCost(req: GenerationRequest, model: ModelDescriptor): number;
}
