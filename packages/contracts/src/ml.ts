import { z } from 'zod';

/**
 * §7 ML 추론 서비스 계약 (crez-ml).
 * crez-ml은 stateless이며 DB에 접근하지 않는다. 합격/불합격 판단을 하지 않고
 * 점수와 원시 시계열만 반환한다. 임계값 적용은 crez-api의 QC 규칙 엔진 담당.
 * 모든 응답은 재현성을 위해 modelBundle(모델명+버전)을 포함한다.
 */

export const ModelBundle = z.object({
  detector: z.string(),        // 'yunet@2023mar'
  faceEmbedder: z.string(),    // 'sface@2021dec'
  // 가중치가 배치되지 않은 단계는 null로 온다 — 모델 미도입과 필드 누락을 구분해야 하므로
  // optional이 아니라 nullable로 받는다.
  bodyDetector: z.string().nullable().optional(),   // 'rtmdet-m@1.0'
  tracker: z.string().nullable().optional(),        // 'bytetrack@1.0'
  poseEstimator: z.string().nullable().optional(),  // 'rtmpose-m@1.0'
  runtime: z.string(),         // 'onnxruntime-1.19-cpu' | 'mock'
});

export const BBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** POST /v1/embed/face */
export const EmbedFaceRequest = z.object({
  imageKeys: z.array(z.string()).min(1).max(64),
  traceId: z.string().optional(),
});

export const FaceEmbeddingResult = z.object({
  imageKey: z.string(),
  ok: z.boolean(),
  error: z.string().nullable().optional(),
  vector: z.array(z.number()).nullable(),
  dim: z.number().int().nullable(),
  /** 블러/노출/해상도/얼굴크기 종합 (§4.2 identity_asset.quality_score) */
  quality: z.number().min(0).max(1).nullable(),
  bbox: BBox.nullable(),
  landmarks: z.array(z.tuple([z.number(), z.number()])).nullable(),
  /** 정면성 — 썸네일 선별(§13) 및 프레임 가중치(§9.2)에 사용 */
  frontality: z.number().min(0).max(1).nullable().optional(),
});

export const EmbedFaceResponse = z.object({
  results: z.array(FaceEmbeddingResult),
  modelBundle: ModelBundle,
});

/** POST /v1/embed/body */
export const EmbedBodyRequest = z.object({
  imageKeys: z.array(z.string()).min(1).max(64),
  traceId: z.string().optional(),
});

export const BodyEmbeddingResult = z.object({
  imageKey: z.string(),
  ok: z.boolean(),
  error: z.string().nullable().optional(),
  vector: z.array(z.number()).nullable(),
  dim: z.number().int().nullable(),
  /** 신체 비율 측정치 — shoulderHipRatio, legTorsoRatio 등 */
  bodyRatios: z.record(z.number()).nullable(),
  quality: z.number().min(0).max(1).nullable(),
});

export const EmbedBodyResponse = z.object({
  results: z.array(BodyEmbeddingResult),
  modelBundle: ModelBundle,
});

/** POST /v1/profile/aggregate */
export const AggregateRequest = z.object({
  vectors: z.array(z.object({ id: z.string(), vector: z.array(z.number()), quality: z.number().nullable() })).min(1),
  /** 이상치 판정 배수 (median absolute deviation) */
  outlierSigma: z.number().default(3.0),
  traceId: z.string().optional(),
});

export const AggregateResponse = z.object({
  centroid: z.array(z.number()),
  dim: z.number().int(),
  /** 임베딩 산포 — 과다 시 CREZ-IDN-003 판단 근거 (판단은 api가) */
  variance: z.number(),
  meanPairwiseSimilarity: z.number(),
  outlierIds: z.array(z.string()),
  usedIds: z.array(z.string()),
});

/** POST /v1/video/analyze — person track 배열 */
export const VideoAnalyzeRequest = z.object({
  videoKey: z.string(),
  sampleFps: z.number().default(5),
  maxPersons: z.number().int().default(10),
  extractKeypoints: z.boolean().default(true),
  traceId: z.string().optional(),
});

export const TrackFrame = z.object({
  ms: z.number().int(),
  bbox: BBox,
  /** RTMPose 17-keypoint (x, y, score) */
  keypoints: z.array(z.tuple([z.number(), z.number(), z.number()])).nullable().optional(),
  faceQuality: z.number().nullable(),
  faceVector: z.array(z.number()).nullable().optional(),
  /** 가림 추정도 — 가림 구간은 점수 가중치 하향 (§9.2) */
  occlusion: z.number().min(0).max(1).nullable().optional(),
});

export const PersonTrack = z.object({
  trackIndex: z.number().int(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  /** 상위 품질 프레임의 trimmed mean (§9.2) */
  faceCentroid: z.array(z.number()).nullable(),
  bodyCentroid: z.array(z.number()).nullable(),
  quality: z.number().min(0).max(1),
  frameCount: z.number().int(),
  frames: z.array(TrackFrame),
});

export const VideoAnalyzeResponse = z.object({
  videoKey: z.string(),
  durationMs: z.number().int(),
  fps: z.number(),
  width: z.number().int(),
  height: z.number().int(),
  tracks: z.array(PersonTrack),
  modelBundle: ModelBundle,
});

/** POST /v1/identity/assign — Hungarian 전역 최적 1:1 할당 (§9.1) */
export const IdentityAssignRequest = z.object({
  tracks: z.array(
    z.object({
      trackIndex: z.number().int(),
      faceCentroid: z.array(z.number()).nullable(),
      bodyCentroid: z.array(z.number()).nullable(),
      quality: z.number(),
      frames: z.array(z.object({
        ms: z.number().int(),
        faceVector: z.array(z.number()).nullable(),
        faceQuality: z.number().nullable(),
        occlusion: z.number().nullable().optional(),
      })).optional(),
    }),
  ),
  references: z.array(
    z.object({
      identityId: z.string(),
      faceCentroid: z.array(z.number()),
      bodyCentroid: z.array(z.number()).nullable().optional(),
    }),
  ).min(1),
  traceId: z.string().optional(),
});

export const AssignmentResult = z.object({
  trackIndex: z.number().int(),
  identityId: z.string().nullable(),
  similarity: z.number(),
  /** 1·2순위 차 — δ_margin 판정용 */
  runnerUpIdentityId: z.string().nullable(),
  runnerUpSimilarity: z.number().nullable(),
  margin: z.number().nullable(),
});

export const IdentityAssignResponse = z.object({
  assignments: z.array(AssignmentResult),
  /** 프레임별 유사도 시계열 — { identityId: [{ms, similarity}] } */
  similaritySeries: z.record(z.array(z.object({ ms: z.number().int(), similarity: z.number(), trackIndex: z.number().int() }))),
  costMatrix: z.array(z.array(z.number())),
  modelBundle: ModelBundle,
});

/** POST /v1/qc/score — 점수와 원시 시계열만 반환. 합격 판단 없음 (§7) */
export const QcScoreRequest = z.object({
  videoKey: z.string(),
  /** identityId → 참조 프로파일 centroid */
  references: z.array(z.object({
    identityId: z.string(),
    faceCentroid: z.array(z.number()),
    bodyCentroid: z.array(z.number()).nullable().optional(),
    bodyRatios: z.record(z.number()).nullable().optional(),
  })).min(1),
  /** 소스 안무 keypoint 시계열 키 — motion_consistency(DTW) 산출용. 없으면 motion=null */
  sourceTracksKey: z.string().nullable().optional(),
  sampleFps: z.number().default(5),
  traceId: z.string().optional(),
});

export const PerIdentityRawMetrics = z.object({
  identityId: z.string(),
  faceSimilarity: z.number(),
  /** 신체 기준 벡터가 없으면 null — 상위 계층이 가중치를 재분배한다 */
  bodySimilarity: z.number().nullable(),
  temporalConsistency: z.number(),
  /** 신체의 시간축 안정성. 얼굴과 별도로 산출 */
  temporalBodyConsistency: z.number().nullable().optional(),
  motionConsistency: z.number().nullable(),
  bindingStability: z.number(),
  validFrameRatio: z.number(),
  /** 프레임 단위 원시 시계열 — 규칙 엔진(§10.2)이 소비 */
  series: z.array(z.object({
    ms: z.number().int(),
    similarity: z.number(),
    runnerUpSimilarity: z.number().nullable(),
    runnerUpIdentityId: z.string().nullable(),
    nearestIdentityId: z.string().nullable(),
    trackIndex: z.number().int().nullable(),
    frameQuality: z.number(),
    occlusion: z.number(),
    /** frame-to-frame 얼굴 변화량 */
    embeddingDelta: z.number().nullable(),
    /** 신체 신호 — 얼굴과 독립. 기준 신체 벡터가 없으면 null */
    bodySimilarity: z.number().nullable().optional(),
    bodyDelta: z.number().nullable().optional(),
  })),
  /** track 단위 판정 근거 (§9.2) */
  trackSpans: z.array(z.object({
    trackIndex: z.number().int(),
    startMs: z.number().int(),
    endMs: z.number().int(),
    assigned: z.boolean(),
  })),
});

export const QcScoreResponse = z.object({
  videoKey: z.string(),
  durationMs: z.number().int(),
  perIdentity: z.array(PerIdentityRawMetrics),
  modelBundle: ModelBundle,
});

/** POST /v1/qc/artifact */
export const QcArtifactRequest = z.object({
  videoKey: z.string(),
  sampleFps: z.number().default(5),
  traceId: z.string().optional(),
});

export const ArtifactSpan = z.object({
  kind: z.enum(['FACE_ARTIFACT', 'HAND_ARTIFACT', 'TEMPORAL_FLICKER', 'FRAME_ANOMALY']),
  startMs: z.number().int(),
  endMs: z.number().int(),
  score: z.number(),
  frameIndices: z.array(z.number().int()),
});

export const QcArtifactResponse = z.object({
  videoKey: z.string(),
  spans: z.array(ArtifactSpan),
  modelBundle: ModelBundle,
});

/** 프레임 썸네일 추출 — finding 근거 이미지 생성 (§10.2) */
export const ExtractFramesRequest = z.object({
  videoKey: z.string(),
  timestampsMs: z.array(z.number().int()).min(1).max(50),
  outputPrefix: z.string(),
  traceId: z.string().optional(),
});

export const ExtractFramesResponse = z.object({
  frames: z.array(z.object({ ms: z.number().int(), key: z.string() })),
});

export type ModelBundle = z.infer<typeof ModelBundle>;
export type VideoAnalyzeResponse = z.infer<typeof VideoAnalyzeResponse>;
export type PersonTrack = z.infer<typeof PersonTrack>;
export type IdentityAssignResponse = z.infer<typeof IdentityAssignResponse>;
export type QcScoreResponse = z.infer<typeof QcScoreResponse>;
export type PerIdentityRawMetrics = z.infer<typeof PerIdentityRawMetrics>;
export type QcArtifactResponse = z.infer<typeof QcArtifactResponse>;
export type AggregateResponse = z.infer<typeof AggregateResponse>;
export type EmbedFaceResponse = z.infer<typeof EmbedFaceResponse>;

export type EmbedFaceRequest = z.infer<typeof EmbedFaceRequest>;
export type EmbedBodyRequest = z.infer<typeof EmbedBodyRequest>;
export type EmbedBodyResponse = z.infer<typeof EmbedBodyResponse>;
export type AggregateRequest = z.infer<typeof AggregateRequest>;
export type VideoAnalyzeRequest = z.infer<typeof VideoAnalyzeRequest>;
export type IdentityAssignRequest = z.infer<typeof IdentityAssignRequest>;
export type AssignmentResult = z.infer<typeof AssignmentResult>;
export type QcScoreRequest = z.infer<typeof QcScoreRequest>;
export type QcArtifactRequest = z.infer<typeof QcArtifactRequest>;
export type ExtractFramesRequest = z.infer<typeof ExtractFramesRequest>;
export type ExtractFramesResponse = z.infer<typeof ExtractFramesResponse>;
export type TrackFrame = z.infer<typeof TrackFrame>;
export type BBox = z.infer<typeof BBox>;
export type ArtifactSpan = z.infer<typeof ArtifactSpan>;
export type FaceEmbeddingResult = z.infer<typeof FaceEmbeddingResult>;
export type BodyEmbeddingResult = z.infer<typeof BodyEmbeddingResult>;
