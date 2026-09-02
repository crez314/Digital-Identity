"""신체 임베딩 및 비율 측정 — §7 /v1/embed/body."""
from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from ..encoders.registry import body_encoder as get_body_encoder
from . import models, storage
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


def embed_keys(keys: list[str], derive_from_face: bool = True) -> list[dict]:
    """
    이미지에서 신체 특징을 추출한다.

    derive_from_face=True이면 얼굴을 먼저 검출해 인체 비례로 신체 영역을 유도한 뒤
    그 crop을 인코딩한다. **기준 이미지와 영상 프레임이 같은 방식으로 잘려야
    비교가 성립한다** — 한쪽은 전신 사진 전체, 다른 쪽은 유도된 영역이면
    구도 차이가 신원 차이로 둔갑한다.

    얼굴이 검출되지 않으면 이미지 전체를 신체 crop으로 본다(전신 사진 가정).
    """
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

            crop_img = image
            derived = False
            if derive_from_face:
                from .body_region import crop as crop_region
                from .body_region import person_region
                from .face import detect_faces

                faces = detect_faces(image)
                if faces:
                    row, _ = max(faces, key=lambda f: f[0][2] * f[0][3])
                    x, y, w, h = (float(v) for v in row[:4])
                    fh, fw = image.shape[:2]
                    sub = crop_region(image, person_region(x, y, w, h, fw, fh))
                    if sub is not None:
                        crop_img = sub
                        derived = True

            encoder = get_body_encoder()
            result = encoder.encode(crop_img)
            if not result.ok or result.vector is None:
                out.append({"imageKey": key, "ok": False, "error": result.error,
                            "vector": None, "dim": None, "bodyRatios": None, "quality": None})
                continue

            out.append({
                "imageKey": key, "ok": True, "error": None,
                "vector": result.vector.tolist(), "dim": encoder.info.dim,
                "bodyRatios": None,  # 포즈 모델 없이는 산출하지 않는다
                "quality": result.quality,
                "derivedFromFace": derived,
            })
        except Exception as e:
            log.exception("body embed failed key=%s", key)
            out.append({"imageKey": key, "ok": False, "error": str(e),
                        "vector": None, "dim": None, "bodyRatios": None, "quality": None})
        finally:
            if path is not None:
                path.unlink(missing_ok=True)
    return out
