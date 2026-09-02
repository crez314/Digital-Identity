"""
§3: DTO 단일 출처는 packages/contracts다.
여기 Pydantic 모델은 그 JSON Schema(services/ml/schemas/contracts.schema.json)의 미러이며,
CI가 두 정의의 정합성을 검사한다(tests/test_contract_parity.py).
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class ModelBundle(BaseModel):
    detector: str
    faceEmbedder: str
    bodyDetector: str | None = None
    tracker: str | None = None
    poseEstimator: str | None = None
    runtime: str


class BBox(BaseModel):
    x: float
    y: float
    w: float
    h: float


# ── /v1/embed/face ───────────────────────────────────────
class EmbedFaceRequest(BaseModel):
    imageKeys: list[str] = Field(min_length=1, max_length=64)
    traceId: str | None = None


class FaceEmbeddingResult(BaseModel):
    imageKey: str
    ok: bool
    error: str | None = None
    vector: list[float] | None = None
    dim: int | None = None
    quality: float | None = None
    bbox: BBox | None = None
    landmarks: list[tuple[float, float]] | None = None
    frontality: float | None = None


class EmbedFaceResponse(BaseModel):
    results: list[FaceEmbeddingResult]
    modelBundle: ModelBundle


# ── /v1/embed/body ───────────────────────────────────────
class EmbedBodyRequest(BaseModel):
    imageKeys: list[str] = Field(min_length=1, max_length=64)
    traceId: str | None = None


class BodyEmbeddingResult(BaseModel):
    imageKey: str
    ok: bool
    error: str | None = None
    vector: list[float] | None = None
    dim: int | None = None
    bodyRatios: dict[str, float] | None = None
    quality: float | None = None


class EmbedBodyResponse(BaseModel):
    results: list[BodyEmbeddingResult]
    modelBundle: ModelBundle


# ── /v1/profile/aggregate ────────────────────────────────
class AggregateVector(BaseModel):
    id: str
    vector: list[float]
    quality: float | None = None


class AggregateRequest(BaseModel):
    vectors: list[AggregateVector] = Field(min_length=1)
    outlierSigma: float = 3.0
    traceId: str | None = None


class AggregateResponse(BaseModel):
    centroid: list[float]
    dim: int
    variance: float
    meanPairwiseSimilarity: float
    outlierIds: list[str]
    usedIds: list[str]


# ── /v1/video/analyze ────────────────────────────────────
class VideoAnalyzeRequest(BaseModel):
    videoKey: str
    sampleFps: float = 5
    maxPersons: int = 10
    extractKeypoints: bool = True
    traceId: str | None = None


class TrackFrame(BaseModel):
    ms: int
    bbox: BBox
    keypoints: list[tuple[float, float, float]] | None = None
    faceQuality: float | None = None
    faceVector: list[float] | None = None
    occlusion: float | None = None


class PersonTrack(BaseModel):
    trackIndex: int
    startMs: int
    endMs: int
    faceCentroid: list[float] | None = None
    bodyCentroid: list[float] | None = None
    quality: float
    frameCount: int
    frames: list[TrackFrame]


class VideoAnalyzeResponse(BaseModel):
    videoKey: str
    durationMs: int
    fps: float
    width: int
    height: int
    tracks: list[PersonTrack]
    modelBundle: ModelBundle


# ── /v1/identity/assign ──────────────────────────────────
class AssignTrackFrame(BaseModel):
    ms: int
    faceVector: list[float] | None = None
    faceQuality: float | None = None
    occlusion: float | None = None


class AssignTrack(BaseModel):
    trackIndex: int
    faceCentroid: list[float] | None = None
    bodyCentroid: list[float] | None = None
    quality: float
    frames: list[AssignTrackFrame] | None = None


class AssignReference(BaseModel):
    identityId: str
    faceCentroid: list[float]
    bodyCentroid: list[float] | None = None


class IdentityAssignRequest(BaseModel):
    tracks: list[AssignTrack]
    references: list[AssignReference] = Field(min_length=1)
    traceId: str | None = None


class AssignmentResult(BaseModel):
    trackIndex: int
    identityId: str | None
    similarity: float
    runnerUpIdentityId: str | None
    runnerUpSimilarity: float | None
    margin: float | None


class SimilarityPoint(BaseModel):
    ms: int
    similarity: float
    trackIndex: int


class IdentityAssignResponse(BaseModel):
    assignments: list[AssignmentResult]
    similaritySeries: dict[str, list[SimilarityPoint]]
    costMatrix: list[list[float]]
    modelBundle: ModelBundle


# ── /v1/qc/score ─────────────────────────────────────────
class QcReference(BaseModel):
    identityId: str
    faceCentroid: list[float]
    bodyCentroid: list[float] | None = None
    bodyRatios: dict[str, float] | None = None


class QcScoreRequest(BaseModel):
    videoKey: str
    references: list[QcReference] = Field(min_length=1)
    sourceTracksKey: str | None = None
    sampleFps: float = 5
    traceId: str | None = None


class QcSeriesPoint(BaseModel):
    ms: int
    similarity: float
    runnerUpSimilarity: float | None
    runnerUpIdentityId: str | None
    nearestIdentityId: str | None
    trackIndex: int | None
    frameQuality: float
    occlusion: float
    # frame-to-frame 얼굴 변화량
    embeddingDelta: float | None
    # 신체 신호 — 얼굴과 독립. 기준 신체 벡터가 없으면 None
    bodySimilarity: float | None = None
    bodyDelta: float | None = None


class TrackSpan(BaseModel):
    trackIndex: int
    startMs: int
    endMs: int
    assigned: bool


class PerIdentityRawMetrics(BaseModel):
    identityId: str
    faceSimilarity: float
    bodySimilarity: float | None
    temporalConsistency: float
    # 신체의 시간축 안정성 — 얼굴과 별도로 산출한다
    temporalBodyConsistency: float | None = None
    motionConsistency: float | None
    bindingStability: float
    validFrameRatio: float
    series: list[QcSeriesPoint]
    trackSpans: list[TrackSpan]


class QcScoreResponse(BaseModel):
    videoKey: str
    durationMs: int
    perIdentity: list[PerIdentityRawMetrics]
    modelBundle: ModelBundle


# ── /v1/qc/artifact ──────────────────────────────────────
class QcArtifactRequest(BaseModel):
    videoKey: str
    sampleFps: float = 5
    traceId: str | None = None


class ArtifactSpan(BaseModel):
    kind: str
    startMs: int
    endMs: int
    score: float
    frameIndices: list[int]


class QcArtifactResponse(BaseModel):
    videoKey: str
    spans: list[ArtifactSpan]
    modelBundle: ModelBundle


# ── /v1/media/frames ─────────────────────────────────────
class ExtractFramesRequest(BaseModel):
    videoKey: str
    timestampsMs: list[int] = Field(min_length=1, max_length=50)
    outputPrefix: str
    traceId: str | None = None


class ExtractedFrame(BaseModel):
    ms: int
    key: str


class ExtractFramesResponse(BaseModel):
    frames: list[ExtractedFrame]
