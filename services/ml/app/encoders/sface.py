"""
SFace 얼굴 인코더 (production 트랙).

opencv_zoo 배포판이며 코드·가중치 모두 Apache 2.0으로 상업 이용이 허용된다.
CREZ의 기본 얼굴 인코더다.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

import cv2
import numpy as np

from ..services.imaging import frontality, quality_score
from .base import (
    EncodeResult,
    EncoderInfo,
    EncoderUnavailable,
    FaceEncoder,
    LicenseTrack,
)

log = logging.getLogger(__name__)


def _expand(path: str) -> Path:
    """설정의 ${MODEL_DIR} 치환."""
    from ..config import settings
    return Path(os.path.expandvars(path.replace("${MODEL_DIR}", str(settings().model_dir))))


class SFaceEncoder(FaceEncoder):
    def __init__(self, detector_path: str, recognizer_path: str, storage_dim: int = 512):
        self._det_path = _expand(detector_path)
        self._rec_path = _expand(recognizer_path)
        self._storage_dim = storage_dim
        self._det = None
        self._rec = None

    @property
    def info(self) -> EncoderInfo:
        return EncoderInfo(
            name="sface", version="2021dec", dim=self._storage_dim,
            track=LicenseTrack.PRODUCTION,
            weights_source="https://github.com/opencv/opencv_zoo (face_recognition_sface)",
            weights_license="Apache-2.0",
            notes="LFW 0.9940. MobileFaceNet 백본. 네이티브 128차원을 저장 차원으로 0 패딩.",
        )

    def _detector(self, w: int, h: int):
        if not self._det_path.exists():
            raise EncoderUnavailable(f"YuNet 가중치 없음: {self._det_path}")
        if self._det is None:
            self._det = cv2.FaceDetectorYN.create(
                str(self._det_path), "", (w, h),
                score_threshold=0.6, nms_threshold=0.3, top_k=50,
            )
        self._det.setInputSize((w, h))
        return self._det

    def _recognizer(self):
        if not self._rec_path.exists():
            raise EncoderUnavailable(f"SFace 가중치 없음: {self._rec_path}")
        if self._rec is None:
            self._rec = cv2.FaceRecognizerSF.create(str(self._rec_path), "")
        return self._rec

    def encode(self, image: np.ndarray) -> EncodeResult:
        if image is None or image.size == 0:
            return EncodeResult(ok=False, error="빈 이미지")

        h, w = image.shape[:2]
        _, faces = self._detector(w, h).detect(image)
        if faces is None or len(faces) == 0:
            return EncodeResult(ok=False, error="no face detected")

        # 가장 큰 얼굴을 피사체로 본다
        row = max(faces, key=lambda f: f[2] * f[3])
        x, y, bw, bh = (float(v) for v in row[:4])
        landmarks = np.array(row[4:14], dtype=np.float32).reshape(5, 2)

        rec = self._recognizer()
        try:
            aligned = rec.alignCrop(image, row)
            feature = rec.feature(aligned)
        except Exception as e:  # noqa: BLE001 — 정렬 실패 프레임은 건너뛴다
            return EncodeResult(ok=False, error=f"align/feature 실패: {e}")

        x0, y0 = max(0, int(x)), max(0, int(y))
        crop = image[y0:y0 + int(bh), x0:x0 + int(bw)]
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.size else np.zeros((1, 1), np.uint8)
        front = frontality(landmarks)

        vec = self.l2_normalize(feature)
        if vec.size < self._storage_dim:
            padded = np.zeros(self._storage_dim, dtype=np.float32)
            padded[:vec.size] = vec
            vec = padded

        return EncodeResult(
            ok=True, vector=vec,
            quality=quality_score(gray, bh, h, front),
            meta={
                "bbox": {"x": x, "y": y, "w": bw, "h": bh},
                "landmarks": landmarks.tolist(),
                "frontality": front,
                "nativeDim": int(np.asarray(feature).size),
            },
        )
