"""
crez-ml — §7 ML 추론 서비스.

원칙:
  - stateless. DB에 접근하지 않는다.
  - 입력은 스토리지 키와 참조 벡터, 출력은 순수 계산 결과.
  - 합격/불합격을 판단하지 않는다. 임계값 적용은 crez-api의 QC 규칙 엔진 몫이다.
  - 모든 응답에 modelBundle(모델명+버전)을 포함해 재현성을 확보한다.
"""
from __future__ import annotations

import logging
import time

from fastapi import Depends, FastAPI, Header, HTTPException

from .config import settings
from .schemas import (
    AggregateRequest,
    AggregateResponse,
    EmbedBodyRequest,
    EmbedBodyResponse,
    EmbedFaceRequest,
    EmbedFaceResponse,
    ExtractFramesRequest,
    ExtractFramesResponse,
    IdentityAssignRequest,
    IdentityAssignResponse,
    QcArtifactRequest,
    QcArtifactResponse,
    QcScoreRequest,
    QcScoreResponse,
    VideoAnalyzeRequest,
    VideoAnalyzeResponse,
)
from .services import aggregate as aggregate_svc
from .services import artifacts as artifacts_svc
from .services import assign as assign_svc
from .services import body as body_svc
from .services import face as face_svc
from .services import models as model_registry
from .services import qc as qc_svc
from .services import video as video_svc

logging.basicConfig(level=settings().log_level)
log = logging.getLogger("crez-ml")

app = FastAPI(title="crez-ml", version="1.1.0", description="CREZ DICE ML inference service (spec §7)")


def verify_internal(x_internal_token: str | None = Header(default=None)) -> None:
    """서비스 간 호출만 허용한다 (§1.1 내부 토큰)."""
    expected = settings().ml_internal_token
    if expected and x_internal_token != expected:
        raise HTTPException(status_code=401, detail="invalid internal token")


@app.middleware("http")
async def timing(request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    response.headers["x-ml-duration-ms"] = f"{(time.perf_counter() - started) * 1000:.1f}"
    return response


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "mode": "mock" if model_registry.is_mock() else settings().ml_mode,
        "modelsPresent": model_registry.has_models(),
        "modelBundle": model_registry.bundle(),
    }


@app.post("/v1/embed/face", response_model=EmbedFaceResponse, dependencies=[Depends(verify_internal)])
def embed_face(req: EmbedFaceRequest) -> EmbedFaceResponse:
    return EmbedFaceResponse(results=face_svc.embed_keys(req.imageKeys), modelBundle=model_registry.bundle())


@app.post("/v1/embed/body", response_model=EmbedBodyResponse, dependencies=[Depends(verify_internal)])
def embed_body(req: EmbedBodyRequest) -> EmbedBodyResponse:
    return EmbedBodyResponse(results=body_svc.embed_keys(req.imageKeys), modelBundle=model_registry.bundle())


@app.post("/v1/profile/aggregate", response_model=AggregateResponse, dependencies=[Depends(verify_internal)])
def profile_aggregate(req: AggregateRequest) -> AggregateResponse:
    result = aggregate_svc.aggregate([v.model_dump() for v in req.vectors], req.outlierSigma)
    return AggregateResponse(**result)


@app.post("/v1/video/analyze", response_model=VideoAnalyzeResponse, dependencies=[Depends(verify_internal)])
def video_analyze(req: VideoAnalyzeRequest) -> VideoAnalyzeResponse:
    return VideoAnalyzeResponse(**video_svc.analyze(req.videoKey, req.sampleFps, req.maxPersons))


@app.post("/v1/identity/assign", response_model=IdentityAssignResponse, dependencies=[Depends(verify_internal)])
def identity_assign(req: IdentityAssignRequest) -> IdentityAssignResponse:
    result = assign_svc.assign(
        [t.model_dump() for t in req.tracks],
        [r.model_dump() for r in req.references],
    )
    return IdentityAssignResponse(**result)


@app.post("/v1/qc/score", response_model=QcScoreResponse, dependencies=[Depends(verify_internal)])
def qc_score(req: QcScoreRequest) -> QcScoreResponse:
    result = qc_svc.score(
        req.videoKey, [r.model_dump() for r in req.references], req.sourceTracksKey, req.sampleFps,
    )
    return QcScoreResponse(**result)


@app.post("/v1/qc/artifact", response_model=QcArtifactResponse, dependencies=[Depends(verify_internal)])
def qc_artifact(req: QcArtifactRequest) -> QcArtifactResponse:
    return QcArtifactResponse(**artifacts_svc.detect(req.videoKey, req.sampleFps))


@app.post("/v1/media/frames", response_model=ExtractFramesResponse, dependencies=[Depends(verify_internal)])
def media_frames(req: ExtractFramesRequest) -> ExtractFramesResponse:
    frames = video_svc.extract_frames(req.videoKey, req.timestampsMs, req.outputPrefix)
    return ExtractFramesResponse(frames=frames)
