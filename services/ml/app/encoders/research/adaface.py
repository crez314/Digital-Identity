"""AdaFace 얼굴 인코더 (research 트랙). 가중치 상업 이용 불가 — 비교 실험 전용."""
from __future__ import annotations

import logging
import os
from pathlib import Path

import cv2
import numpy as np

from ..base import EncodeResult, EncoderInfo, EncoderUnavailable, FaceEncoder, LicenseTrack

log = logging.getLogger(__name__)


def _expand(path: str) -> Path:
    from ...config import settings
    return Path(os.path.expandvars(path.replace("${MODEL_DIR}", str(settings().model_dir))))


class AdaFaceEncoder(FaceEncoder):
    """
    AdaFace(MIT 코드) 추론 래퍼.

    torch와 체크포인트가 모두 있어야 동작한다. 없으면 EncoderUnavailable을 던지며,
    파이프라인은 production 인코더로 계속 진행한다.
    """

    def __init__(self, checkpoint: str, architecture: str = "ir_50", storage_dim: int = 512):
        self._ckpt = _expand(checkpoint)
        self._arch = architecture
        self._storage_dim = storage_dim
        self._model = None

    @property
    def info(self) -> EncoderInfo:
        return EncoderInfo(
            name=f"adaface-{self._arch}", version="research", dim=self._storage_dim,
            track=LicenseTrack.RESEARCH,
            weights_source="https://github.com/mk-minchul/AdaFace",
            weights_license="코드 MIT / 가중치 비상업 연구 전용 (MS1MV2·WebFace·CASIA 학습)",
            notes="상업 이용 불가. 성능 비교 목적으로만 사용한다.",
        )

    def _load(self):
        if self._model is not None:
            return self._model
        try:
            import torch  # noqa: F401
        except ImportError as e:
            raise EncoderUnavailable(
                "AdaFace를 쓰려면 torch가 필요합니다: "
                "pip install -r services/ml/requirements-research.txt"
            ) from e
        if not self._ckpt.exists():
            raise EncoderUnavailable(f"AdaFace 체크포인트 없음: {self._ckpt}")

        import torch
        from .adaface_net import build_model  # 공식 구현의 backbone 정의

        model = build_model(self._arch)
        state = torch.load(str(self._ckpt), map_location="cpu")
        sd = {k[6:]: v for k, v in state["state_dict"].items() if k.startswith("model.")}
        model.load_state_dict(sd)
        model.eval()
        self._model = model
        return model

    def encode(self, image: np.ndarray) -> EncodeResult:
        import torch

        model = self._load()
        # AdaFace 입력 규약: 112x112 BGR, [-1, 1] 정규화
        face = cv2.resize(image, (112, 112))
        tensor = ((face.astype(np.float32) / 255.0) - 0.5) / 0.5
        tensor = torch.from_numpy(tensor.transpose(2, 0, 1)).unsqueeze(0)

        with torch.no_grad():
            feature, _ = model(tensor)
        vec = self.l2_normalize(feature.numpy())

        if vec.size < self._storage_dim:
            padded = np.zeros(self._storage_dim, dtype=np.float32)
            padded[:vec.size] = vec
            vec = padded
        return EncodeResult(ok=True, vector=vec, quality=None,
                            meta={"nativeDim": int(feature.numel())})
