"""프레임 품질 산출과 얼굴 처리 유틸."""
from __future__ import annotations

import cv2
import numpy as np


def blur_score(gray: np.ndarray) -> float:
    """Laplacian 분산 — 값이 클수록 선명하다. 0..1로 정규화."""
    v = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    return float(min(1.0, v / 500.0))


def exposure_score(gray: np.ndarray) -> float:
    """평균 밝기가 중간 대역에 있고 클리핑이 적을수록 높다."""
    mean = float(gray.mean()) / 255.0
    clipped = float(((gray < 5) | (gray > 250)).mean())
    center = 1.0 - abs(mean - 0.5) * 2.0
    return float(max(0.0, min(1.0, center * (1.0 - clipped))))


def face_size_score(bbox_h: float, frame_h: int) -> float:
    """얼굴이 프레임에서 차지하는 비율. 너무 작으면 임베딩 신뢰도가 떨어진다."""
    if frame_h <= 0:
        return 0.0
    ratio = bbox_h / frame_h
    return float(max(0.0, min(1.0, ratio / 0.25)))


def frontality(landmarks: np.ndarray | None) -> float:
    """
    5점 랜드마크(좌눈/우눈/코/좌입/우입)로 정면성을 추정한다.
    코가 두 눈 중점에 가까울수록 정면이다. 측면 프레임은 가중치를 낮춘다(§9.2).
    """
    if landmarks is None or len(landmarks) < 3:
        return 0.5
    le, re, nose = landmarks[0], landmarks[1], landmarks[2]
    eye_mid = (le + re) / 2.0
    eye_dist = float(np.linalg.norm(re - le)) or 1.0
    offset = float(abs(nose[0] - eye_mid[0])) / eye_dist
    return float(max(0.0, min(1.0, 1.0 - offset * 2.0)))


def quality_score(gray_crop: np.ndarray, bbox_h: float, frame_h: int, front: float) -> float:
    """§4.2 identity_asset.quality_score — 블러/노출/해상도/얼굴크기 종합."""
    if gray_crop.size == 0:
        return 0.0
    return float(
        0.35 * blur_score(gray_crop)
        + 0.2 * exposure_score(gray_crop)
        + 0.25 * face_size_score(bbox_h, frame_h)
        + 0.2 * front
    )


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))
