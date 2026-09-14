"""
고해상도 사진의 얼굴 검출 — 줄여서 검출하고 좌표는 원본 기준으로 돌려줘야 한다.

원본(2316x3088)에서 그대로 검출하면 YuNet이 안경 렌즈를 얼굴로 잡는 사례가 있었다(2026-09-11).
가중치 없이 검증하도록 검출기를 가짜로 바꿔 좌표 변환만 확인한다.
"""
from __future__ import annotations

import numpy as np

from app.services import face, models


class _FakeDetector:
    def __init__(self, calls: list) -> None:
        self.calls = calls

    def detect(self, image):
        h, w = image.shape[:2]
        self.calls.append((w, h))
        # 검출기 입력 좌표계에서 화면 중앙에 세로 40% 크기의 얼굴 하나
        bw, bh = w * 0.3, h * 0.4
        x, y = (w - bw) / 2, (h - bh) / 2
        landmarks = [x + bw * 0.3, y + bh * 0.4, x + bw * 0.7, y + bh * 0.4, x + bw * 0.5, y + bh * 0.6,
                     x + bw * 0.35, y + bh * 0.8, x + bw * 0.65, y + bh * 0.8]
        return None, np.array([[x, y, bw, bh, *landmarks, 0.92]], dtype=np.float32)


def _patch(monkeypatch) -> list:
    calls: list = []
    monkeypatch.setattr(models, "face_detector", lambda w, h: _FakeDetector(calls))
    return calls


def test_large_image_is_detected_downscaled_and_mapped_back(monkeypatch):
    calls = _patch(monkeypatch)
    image = np.zeros((3088, 2316, 3), dtype=np.uint8)

    (row, score), = face.detect_faces(image, max_side=face.ASSET_DETECT_MAX_SIDE)

    assert max(calls[0]) == face.ASSET_DETECT_MAX_SIDE  # 검출기에는 줄인 이미지가 들어간다
    assert abs(row[3] / 3088 - 0.4) < 0.01               # 얼굴 높이 비율은 원본 기준으로 유지
    assert abs(row[1] - 3088 * 0.3) < 3                  # 좌표도 원본 픽셀 단위
    assert abs(row[8] - (row[0] + row[2] * 0.5)) < 1     # 랜드마크(코)도 함께 되돌린다
    assert score == np.float32(0.92)                     # 신뢰도는 배율과 무관


def test_small_image_and_video_path_are_not_resized(monkeypatch):
    calls = _patch(monkeypatch)
    face.detect_faces(np.zeros((480, 360, 3), dtype=np.uint8), max_side=face.ASSET_DETECT_MAX_SIDE)
    face.detect_faces(np.zeros((1080, 1920, 3), dtype=np.uint8))  # 영상 경로는 max_side 없이 호출한다
    assert calls == [(360, 480), (1920, 1080)]
