"""프레임 품질 산출과 얼굴 처리 유틸."""
from __future__ import annotations

import cv2
import numpy as np


def blur_score(gray: np.ndarray) -> float:
    """
    Laplacian 분산 — 값이 클수록 선명하다. 0..1로 정규화.

    호출자가 이미 고정 크기로 줄인 이미지를 넘긴다고 가정한다. 원본 해상도 그대로 넣으면
    해상도가 높을수록 점수가 낮아진다 — 그 용도로는 scaled_blur_score를 쓴다.
    """
    v = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    return float(min(1.0, v / 500.0))


#: 선명도를 재기 전에 맞추는 세로 크기. 이 값이 바뀌면 모든 자산 품질 점수가 바뀐다.
SHARPNESS_HEIGHT = 512


def scaled_blur_score(gray: np.ndarray, target_h: int = SHARPNESS_HEIGHT) -> float:
    """
    크기에 좌우되지 않는 선명도.

    Laplacian 분산은 해상도에 크게 좌우된다. 같은 사진을 48MP 원본에서 재면 분산이 35,
    세로 512로 줄여 재면 429가 나온다(2026-09-21 실측). 원본 크기로 재면 "초점이 맞았는가"가
    아니라 "화소가 적은가"를 재게 되고, 최신 휴대폰으로 찍은 선명한 전신 사진이 품질 미달로
    걸러진다. 실제로 4284x5712 전신 사진 2장이 0.12로 떨어져 제외됐다.

    그래서 재기 전에 세로를 맞춘다. 원본이 더 작으면 늘리지 않는다 — 없는 화소를 만들어
    선명하다고 우길 수는 없다.
    """
    if gray.size == 0:
        return 0.0
    h = gray.shape[0]
    if h > target_h:
        w = max(1, int(round(gray.shape[1] * target_h / h)))
        gray = cv2.resize(gray, (w, target_h), interpolation=cv2.INTER_AREA)
    return blur_score(gray)


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
        0.35 * scaled_blur_score(gray_crop)
        + 0.2 * exposure_score(gray_crop)
        + 0.25 * face_size_score(bbox_h, frame_h)
        + 0.2 * front
    )


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))
