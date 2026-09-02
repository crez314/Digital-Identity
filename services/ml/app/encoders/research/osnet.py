"""OSNet 신체 인코더 (research 트랙). 가중치 상업 이용 불가 — 비교 실험 전용."""
from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np

from ..base import BodyEncoder, EncodeResult, EncoderInfo, EncoderUnavailable, LicenseTrack


def _expand(path: str) -> Path:
    from ...config import settings
    return Path(os.path.expandvars(path.replace("${MODEL_DIR}", str(settings().model_dir))))


class OSNetEncoder(BodyEncoder):
    def __init__(self, model_name: str = "osnet_x1_0", weights: str = "", dim: int = 512):
        self._name = model_name
        self._weights = _expand(weights) if weights else None
        self._dim = dim
        self._model = None

    @property
    def info(self) -> EncoderInfo:
        return EncoderInfo(
            name=self._name, version="research", dim=self._dim,
            track=LicenseTrack.RESEARCH,
            weights_source="https://github.com/KaiyangZhou/deep-person-reid",
            weights_license="코드 MIT / 가중치 연구 전용 (Market-1501·MSMT17·DukeMTMC 학습)",
            notes="DukeMTMC는 철회된 데이터셋. 상업 이용 불가.",
        )

    def _load(self):
        if self._model is not None:
            return self._model
        try:
            import torch
            import torchreid
        except ImportError as e:
            raise EncoderUnavailable(
                "OSNet을 쓰려면 torch와 torchreid가 필요합니다: "
                "pip install -r services/ml/requirements-research.txt"
            ) from e

        model = torchreid.models.build_model(
            name=self._name, num_classes=1, pretrained=False,
        )
        if self._weights and self._weights.exists():
            torchreid.utils.load_pretrained_weights(model, str(self._weights))
        model.eval()
        self._model = model
        return model

    def encode(self, image: np.ndarray) -> EncodeResult:
        import torch

        model = self._load()
        # OSNet 입력 규약: 256x128 RGB, ImageNet 정규화
        img = cv2.resize(image, (128, 256))
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        img = (img - mean) / std
        tensor = torch.from_numpy(img.transpose(2, 0, 1)).unsqueeze(0)

        with torch.no_grad():
            feature = model(tensor)
        return EncodeResult(ok=True, vector=self.l2_normalize(feature.numpy()), quality=None,
                            meta={"nativeDim": int(feature.numel())})
