"""FastReID 신체 인코더 (research 트랙). 향후 자체 Re-ID 모델 실험용 슬롯."""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np

from ..base import BodyEncoder, EncodeResult, EncoderInfo, EncoderUnavailable, LicenseTrack


def _expand(path: str) -> Path:
    from ...config import settings
    return Path(os.path.expandvars(path.replace("${MODEL_DIR}", str(settings().model_dir))))


class FastReIDEncoder(BodyEncoder):
    """
    FastReID(Apache 2.0 코드) 래퍼.

    PoC 단계에서는 동시 추론이 필수가 아니다(요구사항 §1). 자체 Body Encoder를
    학습해 교체할 때 이 자리에 들어온다 — 인터페이스만 고정해 둔다.
    """

    def __init__(self, config_file: str = "", weights: str = "", dim: int = 2048):
        self._cfg = _expand(config_file) if config_file else None
        self._weights = _expand(weights) if weights else None
        self._dim = dim
        self._predictor = None

    @property
    def info(self) -> EncoderInfo:
        return EncoderInfo(
            name="fastreid", version="research", dim=self._dim,
            track=LicenseTrack.RESEARCH,
            weights_source="https://github.com/JDAI-CV/fast-reid",
            weights_license="코드 Apache-2.0 / 가중치 연구 전용 데이터셋 학습",
            notes="자체 Re-ID 모델 학습 후 교체 예정 슬롯.",
        )

    def _load(self):
        if self._predictor is not None:
            return self._predictor
        try:
            from fastreid.config import get_cfg
            from fastreid.engine import DefaultPredictor
        except ImportError as e:
            raise EncoderUnavailable(
                "FastReID가 설치되지 않았습니다. requirements-research.txt 참조."
            ) from e
        if not (self._cfg and self._cfg.exists()):
            raise EncoderUnavailable(f"FastReID config 없음: {self._cfg}")

        cfg = get_cfg()
        cfg.merge_from_file(str(self._cfg))
        if self._weights:
            cfg.MODEL.WEIGHTS = str(self._weights)
        cfg.freeze()
        self._predictor = DefaultPredictor(cfg)
        return self._predictor

    def encode(self, image: np.ndarray) -> EncodeResult:
        predictor = self._load()
        feature = predictor(image)
        return EncodeResult(ok=True, vector=self.l2_normalize(np.asarray(feature)), quality=None)
