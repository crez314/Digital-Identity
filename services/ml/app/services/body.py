"""신체 임베딩 및 비율 측정 — §7 /v1/embed/body."""
from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from . import models, storage
from .imaging import blur_score, exposure_score
from .mock import seeded_float, seeded_vector

log = logging.getLogger(__name__)

# RTMPose COCO-17 인덱스
L_SHOULDER, R_SHOULDER, L_HIP, R_HIP, L_KNEE, L_ANKLE = 5, 6, 11, 12, 13, 15


def body_ratios(keypoints: np.ndarray | None) -> dict[str, float] | None:
    """
    포즈 keypoint에서 신체 비율을 뽑는다(§4.2 identity_profile.attributes 신체비율).
    포즈 모델이 없으면 None — 계약상 허용된다.
    """
    if keypoints is None or len(keypoints) < 17:
        return None
    kp = keypoints[:, :2]
    shoulder = float(np.linalg.norm(kp[L_SHOULDER] - kp[R_SHOULDER]))
    hip = float(np.linalg.norm(kp[L_HIP] - kp[R_HIP])) or 1.0
    torso = float(np.linalg.norm((kp[L_SHOULDER] + kp[R_SHOULDER]) / 2 - (kp[L_HIP] + kp[R_HIP]) / 2)) or 1.0
    leg = float(np.linalg.norm(kp[L_HIP] - kp[L_KNEE]) + np.linalg.norm(kp[L_KNEE] - kp[L_ANKLE]))
    return {
        "shoulderHipRatio": shoulder / hip,
        "legTorsoRatio": leg / torso,
        "shoulderTorsoRatio": shoulder / torso,
    }


def color_histogram_embedding(image: np.ndarray, dim: int = models.BODY_DIM) -> np.ndarray:
    """
    RTMDet/전용 ReID 가중치가 없는 환경의 신체 임베딩 폴백.
    의상·체형 색분포 기반이라 변별력은 얼굴보다 낮지만, 후면·측면 프레임에서
    얼굴 임베딩을 보완하는 용도로는 유효하다(§9.2).
    """
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    # 상·하체를 나눠 각각 히스토그램을 만든다 (상의/하의 구분 정보 보존)
    h = image.shape[0]
    parts = [hsv[: h // 2], hsv[h // 2 :]]
    feats = []
    bins = dim // (2 * 3)
    for p in parts:
        for ch in range(3):
            hist = cv2.calcHist([p], [ch], None, [bins], [0, 256]).ravel()
            feats.append(hist)
    v = np.concatenate(feats).astype(np.float32)
    if v.size < dim:
        v = np.pad(v, (0, dim - v.size))
    v = v[:dim]
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def embed_keys(keys: list[str]) -> list[dict]:
    if models.is_mock():
        return [
            {
                "imageKey": k, "ok": True, "error": None,
                "vector": seeded_vector(f"body:{k}", models.BODY_DIM),
                "dim": models.BODY_DIM,
                "bodyRatios": {
                    "shoulderHipRatio": seeded_float(f"shr:{k}", 1.2, 1.4),
                    "legTorsoRatio": seeded_float(f"ltr:{k}", 1.0, 1.3),
                },
                "quality": seeded_float(f"bq:{k}", 0.55, 0.95),
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
                            "vector": None, "dim": None, "bodyRatios": None, "quality": None})
                continue
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            vec = color_histogram_embedding(image)
            out.append({
                "imageKey": key, "ok": True, "error": None,
                "vector": vec.tolist(), "dim": models.BODY_DIM,
                "bodyRatios": None,  # 포즈 모델 없이는 산출하지 않는다
                "quality": float(0.5 * blur_score(gray) + 0.5 * exposure_score(gray)),
            })
        except Exception as e:
            log.exception("body embed failed key=%s", key)
            out.append({"imageKey": key, "ok": False, "error": str(e),
                        "vector": None, "dim": None, "bodyRatios": None, "quality": None})
        finally:
            if path is not None:
                path.unlink(missing_ok=True)
    return out
