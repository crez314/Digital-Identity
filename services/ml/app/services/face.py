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

# 등록용 사진(자산)을 검출할 때의 긴 변 상한.
# YuNet은 작은 얼굴 위주로 학습되어, 휴대폰 원본(2316x3088)처럼 얼굴이 1000px를 넘으면 얼굴 대신
# 안경 렌즈 같은 일부를 얼굴로 잡는다(실측: 원본 얼굴 12.7%·신뢰도 0.64 → 640px 45.8%·0.92).
# 줄인 이미지에서 검출하고 좌표만 원본으로 되돌리므로 정렬·임베딩은 원본 해상도로 한다.
ASSET_DETECT_MAX_SIDE = 640


def detect_faces(image: np.ndarray, max_side: int | None = None) -> list[tuple[np.ndarray, float]]:
    """
    YuNet 검출 결과를 (row, score) 목록으로 돌려준다. row: [x,y,w,h, 5점 랜드마크, score].
    max_side를 주면 긴 변을 그 크기로 줄여 검출한 뒤 좌표를 원본 기준으로 되돌린다.
    """
    h, w = image.shape[:2]
    scale = min(1.0, max_side / max(h, w)) if max_side else 1.0
    target = image if scale == 1.0 else cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    th, tw = target.shape[:2]
    with models.OPENCV_LOCK:
        _, faces = models.face_detector(tw, th).detect(target)
    if faces is None:
        return []
    rows = []
    for f in faces:
        row = np.array(f, dtype=np.float32)
        row[:14] /= scale  # bbox 4개 + 랜드마크 10개. 마지막 신뢰도는 그대로 둔다
        rows.append((row, float(row[-1])))
    return rows


def embed_image(image: np.ndarray, key: str) -> dict:
    """이미지 1장에서 가장 큰 얼굴을 골라 임베딩한다."""
    faces = detect_faces(image, max_side=ASSET_DETECT_MAX_SIDE)
    h, w = image.shape[:2]
    if not faces:
        return {"imageKey": key, "ok": False, "error": "no face detected",
                "vector": None, "dim": None, "quality": None, "bbox": None,
                "landmarks": None, "frontality": None,
                "imageWidth": w, "imageHeight": h, "detectionScore": None, "faceCount": 0}

    # 가장 큰 얼굴 = 피사체로 본다
    row, score = max(faces, key=lambda f: f[0][2] * f[0][3])
    x, y, bw, bh = [float(v) for v in row[:4]]
    landmarks = np.array(row[4:14], dtype=np.float32).reshape(5, 2)

    with models.OPENCV_LOCK:
        aligned = models.face_recognizer().alignCrop(image, row)
        feature = models.face_recognizer().feature(aligned)

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
        # 슬롯 적합성(얼굴 슬롯에 전신 사진 등)은 워커가 이 값들로 판정한다 — ML은 측정만 한다(§2.2)
        "imageWidth": w,
        "imageHeight": h,
        "detectionScore": min(1.0, max(0.0, score)),
        "faceCount": len(faces),
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
                # 얼굴이 화면 세로의 25%인 얼굴 사진으로 가정한다
                "imageWidth": 600, "imageHeight": 800, "detectionScore": 0.9, "faceCount": 1,
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
