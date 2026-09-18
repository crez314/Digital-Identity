import { z } from 'zod';
import { DerivativeKind, FindingType, QcStatus, RegenOutcome, Severity } from './enums';

/** §10 Identity Consistency 점수 체계 / §6.4 QC API */

/** §10.1 지표 정의 — 5개 지표 모두 0–1 */
export const IdentityMetrics = z.object({
  faceSimilarity: z.number().min(0).max(1),
  bodySimilarity: z.number().min(0).max(1).nullable(),
  temporalConsistency: z.number().min(0).max(1),
  /** 신체의 시간축 안정성 — 신체 신호가 없으면 null */
  temporalBodyConsistency: z.number().min(0).max(1).nullable().optional(),
  /** 소스 안무가 없으면 산출 불가 — null이면 가중치를 재분배한다 (§10.1) */
  motionConsistency: z.number().min(0).max(1).nullable(),
  bindingStability: z.number().min(0).max(1),
  /** 유효 프레임 수 / 전체 프레임 수 — 신뢰도 참고값 */
  validFrameRatio: z.number().min(0).max(1).optional(),
});

/** §10 가중치 — 코드에 하드코딩하지 않고 DB ruleset에서 로드 */
export const ScoreWeights = z.object({
  face: z.number(),
  body: z.number(),
  temporal: z.number(),
  binding: z.number(),
  motion: z.number(),
});

export const QcThresholds = z.object({
  /** §10.3 모든 캐스트의 개별 점수 하한 */
  perIdentityMin: z.number(),
  /** §10.3 캐스트 간 점수 편차 허용 범위 */
  maxSpread: z.number(),
  /** 세그먼트 종합 점수 하한 */
  overallMin: z.number(),
  /** §10.2 DRIFT: baseline 대비 하락폭, 지속 시간(초) */
  driftDropRatio: z.number(),
  driftMinDurationSec: z.number(),
  /** §10.2 BLEND: 1·2순위 유사도 차 margin */
  blendMargin: z.number(),
  blendMinDurationSec: z.number(),
  /** §10.2 SWAP: 최근접 identity 전환 후 유지 시간(초) */
  swapMinDurationSec: z.number(),
  /** §10.2 FLICKER: 임베딩 변화량 z-score 임계 */
  flickerZScore: z.number(),
  /** §10.2 TRACK_LOST: 가림 미설명 소실 최소 구간(초) */
  trackLostMinDurationSec: z.number(),
  /** 프레임 유효성 판정 최소 품질 */
  minFrameQuality: z.number(),
  /**
   * §9.1 τ_assign — track을 캐스트 인물로 인정하는 최소 유사도.
   * 이 값을 넘지 못한 track은 "다른 사람"이며 그 인물의 지표에 섞이면 안 된다.
   * 기존 ruleset 행에는 없는 값이라 기본값을 둔다.
   */
  assignMinSimilarity: z.number().default(0.35),
  /**
   * 구간(컷) 사이 인물 점수 편차 허용치. maxSpread가 "한 컷 안 캐스트 인물 간" 편차인 것과 달리,
   * 이 값은 "같은 인물의 컷 간" 편차다 — 컷마다 합격해도 이어 붙이면 사람이 바뀐 것처럼 보이는 경우를 막는다.
   */
  sequenceMaxSpread: z.number().default(0.15),
  /**
   * 얼굴 유사도를 신뢰할 수 있는 최소 얼굴 픽셀 높이.
   *
   * 얼굴이 작으면 임베딩이 흐려져 같은 사람도 유사도가 낮게 나온다. 실측(2026-09-18, 동일 인물·동일 레퍼런스):
   * 84px → 0.504, 87px → 0.443, 113px → 0.556, 140px → 0.711.
   * 이 값 미만이면 점수를 "닮지 않았다"로 읽으면 안 된다 — 판정 근거가 얇다는 뜻이다.
   */
  minFaceHeightPx: z.number().default(110),
});

export const RulesetDto = z.object({
  version: z.string(),
  weights: ScoreWeights,
  thresholds: QcThresholds,
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
});

export const QcFindingDto = z.object({
  id: z.string().uuid(),
  identityId: z.string().uuid().nullable(),
  findingType: FindingType,
  severity: Severity,
  startMs: z.number().int(),
  endMs: z.number().int(),
  confidence: z.number(),
  /** 프레임 인덱스, 유사도 시계열, 썸네일 키 (§4.2) — 근거 없는 finding 금지 (§10.2) */
  evidence: z.object({
    frameIndices: z.array(z.number().int()).optional(),
    similaritySeries: z.array(z.number()).optional(),
    thumbnailKeys: z.array(z.string()).optional(),
    baseline: z.number().optional(),
    note: z.string().optional(),
  }),
});

export const QcRunDto = z.object({
  id: z.string().uuid(),
  outputId: z.string().uuid(),
  rulesetVersion: z.string(),
  status: QcStatus,
  overallScore: z.number().nullable(),
  perIdentity: z.record(IdentityMetrics.extend({ score: z.number() })).nullable(),
  findings: z.array(QcFindingDto).optional(),
  createdAt: z.string().datetime(),
});

/** §11 재생성 전략 사다리 */
export const RegenStrategy = z.object({
  step: z.number().int().min(1).max(5),
  kind: z.enum([
    'CONDITIONING_BOOST',   // 1단계
    'REFERENCE_SWAP',       // 2단계
    'SEGMENT_SPLIT',        // 3단계
    'MODEL_REROUTE',        // 4단계
    'MANUAL_REVIEW',        // 5단계
  ]),
  params: z.record(z.unknown()),
  rationale: z.string(),
});

export const RegenerateRequest = z.object({
  strategyOverride: RegenStrategy.partial().optional(),
  reason: z.string().optional(),
});

export const RegenerationTaskDto = z.object({
  id: z.string().uuid(),
  segmentId: z.string().uuid(),
  sourceQcRunId: z.string().uuid(),
  strategy: RegenStrategy,
  resultJobId: z.string().uuid().nullable(),
  outcome: RegenOutcome.nullable(),
});

/** §6.4 POST /segments/{id}/accept — 사유 필수 (§14.2) */
export const AcceptSegmentRequest = z.object({
  reason: z.string().min(10),
  outputId: z.string().uuid().optional(),
});

export const CreateMasterRequest = z.object({
  normalizeColor: z.boolean().default(true),
  normalizeTiming: z.boolean().default(true),
  /**
   * 구간 간 인물 편차 검사를 건너뛴다. 운영자가 결과를 눈으로 확인하고 그래도 묶겠다고
   * 판단한 경우에만 쓴다 — 감사 기록에 남는다(§14.2).
   */
  ignoreSequenceCheck: z.boolean().default(false),
});

export const CreateDerivativesRequest = z.object({
  kinds: z.array(DerivativeKind).min(1),
  aspectRatios: z.array(z.string()).optional(),
});

export type IdentityMetrics = z.infer<typeof IdentityMetrics>;
export type ScoreWeights = z.infer<typeof ScoreWeights>;
export type QcThresholds = z.infer<typeof QcThresholds>;
export type QcFindingDto = z.infer<typeof QcFindingDto>;
export type RegenStrategy = z.infer<typeof RegenStrategy>;
export type RulesetDto = z.infer<typeof RulesetDto>;

export type QcRunDto = z.infer<typeof QcRunDto>;
export type RegenerateRequest = z.infer<typeof RegenerateRequest>;
export type RegenerationTaskDto = z.infer<typeof RegenerationTaskDto>;
export type AcceptSegmentRequest = z.infer<typeof AcceptSegmentRequest>;
export type CreateMasterRequest = z.infer<typeof CreateMasterRequest>;
export type CreateDerivativesRequest = z.infer<typeof CreateDerivativesRequest>;
