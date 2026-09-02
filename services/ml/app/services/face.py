"""얼굴 검출(YuNet) + 임베딩(SFace) — §7 /v1/embed/face."""
from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from . import models, storage
from .imaging import frontality, quality_score
from .mock import seeded_float, seeded_vector

log = logging.getLogger(__name__)


def detect_faces(image: np.ndarray) -> list[tuple[np.ndarray, float]]:
    """YuNet 검출 결과를 (row, score) 목록으로 돌려준다. row: [x,y,w,h, 5점 랜드마크, score]."""
    h, w = image.shape[:2]
    det = models.face_detector(w, h)
    _, faces = det.detect(image)
    if faces is None:
        return []
    return [(f, float(f[-1])) for f in faces]


def embed_image(image: np.ndarray, key: str) -> dict:
    """이미지 1장에서 가장 큰 얼굴을 골라 임베딩한다."""
    faces = detect_faces(image)
    if not faces:
        return {"imageKey": key, "ok": False, "error": "no face detected",
                "vector": None, "dim": None, "quality": None, "bbox": None,
                "landmarks": None, "frontality": None}

    # 가장 큰 얼굴 = 피사체로 본다
    row, _score = max(faces, key=lambda f: f[0][2] * f[0][3])
    x, y, bw, bh = [float(v) for v in row[:4]]
    landmarks = np.array(row[4:14], dtype=np.float32).reshape(5, 2)

    aligned = models.face_recognizer().alignCrop(image, row)
    feature = models.face_recognizer().feature(aligned)

    h, _w = image.shape[:2]
    x0, y0 = max(0, int(x)), max(0, int(y))
    crop = image[y0 : y0 + int(bh), x0 : x0 + int(bw)]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.size else np.zeros((1, 1), np.uint8)
    front = frontality(landmarks)

    return {
        "imageKey": key,
        "ok": True,
        "error": None,
        "vector": models.pad_to_storage_dim(feature),
        "dim": models.FACE_STORAGE_DIM,
        "quality": quality_score(gray, bh, h, front),
        "bbox": {"x": x, "y": y, "w": bw, "h": bh},
        "landmarks": landmarks.tolist(),
        "frontality": front,
    }


def embed_keys(keys: list[str]) -> list[dict]:
    if models.is_mock():
        return [
            {
                "imageKey": k, "ok": True, "error": None,
                "vector": seeded_vector(k, models.FACE_STORAGE_DIM),
                "dim": models.FACE_STORAGE_DIM,
                "quality": seeded_float(f"q:{k}", 0.55, 0.95),
                "bbox": {"x": 100.0, "y": 100.0, "w": 200.0, "h": 200.0},
                "landmarks": None,
                "frontality": seeded_float(f"f:{k}", 0.6, 1.0),
            }
            for k in keys
        ]

    out: list[dict] = []
    for key in keys:
        path: Path | None = None
        try:
            path = storage.download(key)
            image = cv2.imread(str(path))
            if image is None:
                out.append({"imageKey": key, "ok": False, "error": "decode failed",
                            "vector": None, "dim": None, "quality": None,
                            "bbox": None, "landmarks": None, "frontality": None})
                continue
            out.append(embed_image(image, key))
        except Exception as e:
            log.exception("face embed failed key=%s", key)
            out.append({"imageKey": key, "ok": False, "error": str(e),
                        "vector": None, "dim": None, "quality": None,
                        "bbox": None, "landmarks": None, "frontality": None})
        finally:
            if path is not None:
                path.unlink(missing_ok=True)
    return out
