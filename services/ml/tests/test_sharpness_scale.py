"""
선명도 점수는 해상도에 좌우되면 안 된다.

Laplacian 분산을 원본 크기에서 재면 화소가 많을수록 값이 낮아진다. 같은 전신 사진을
4284x5712 원본에서 재면 분산 35(점수 0.12), 세로 512로 줄여 재면 429(점수 0.86)가
나왔다(2026-09-21 실측). 그 결과 최신 휴대폰으로 찍은 선명한 전신 사진 2장이
품질 미달(0.4 하한)로 제외되어 BODY_FRONT 슬롯이 비었다.

여기서 고정하는 것은 두 가지다.
  · 같은 사진을 키워도 점수가 크게 떨어지지 않는다 (해상도 불변)
  · 흐리게 만들면 점수가 내려간다 (선명도를 재는 본래 목적은 유지)
"""
from __future__ import annotations

import cv2
import numpy as np

from app.services.imaging import SHARPNESS_HEIGHT, scaled_blur_score


def _detailed_image(h: int, w: int) -> np.ndarray:
    """선명한 경계가 많은 회색조 이미지 — 체커보드에 잡음을 얹는다."""
    rng = np.random.default_rng(7)
    ys, xs = np.mgrid[0:h, 0:w]
    checker = (((ys // max(1, h // 32)) + (xs // max(1, w // 32))) % 2 * 200).astype(np.uint8)
    noise = rng.integers(0, 40, size=(h, w), dtype=np.uint8)
    return cv2.add(checker, noise)


def test_점수는_해상도에_좌우되지_않는다() -> None:
    base = _detailed_image(512, 384)
    big = cv2.resize(base, (384 * 8, 512 * 8), interpolation=cv2.INTER_CUBIC)

    small_score = scaled_blur_score(base)
    big_score = scaled_blur_score(big)

    # 같은 그림을 8배로 키웠을 뿐이니 점수가 뒤집혀서는 안 된다.
    # 보간 때문에 완전히 같을 수는 없어 폭만 제한한다.
    assert abs(big_score - small_score) < 0.15, (small_score, big_score)


def test_원본_크기로_재면_해상도에_휘둘린다() -> None:
    """고치기 전 동작을 명시해 둔다 — 이 차이가 이 함수가 존재하는 이유다."""
    base = _detailed_image(512, 384)
    big = cv2.resize(base, (384 * 8, 512 * 8), interpolation=cv2.INTER_CUBIC)

    raw_small = float(cv2.Laplacian(base, cv2.CV_64F).var())
    raw_big = float(cv2.Laplacian(big, cv2.CV_64F).var())

    # 같은 그림인데 키우면 분산이 확 떨어진다
    assert raw_big < raw_small / 4, (raw_small, raw_big)


def test_흐리게_하면_점수가_내려간다() -> None:
    sharp = _detailed_image(SHARPNESS_HEIGHT * 2, SHARPNESS_HEIGHT * 2)
    blurred = cv2.GaussianBlur(sharp, (31, 31), 0)

    assert scaled_blur_score(blurred) < scaled_blur_score(sharp)


def test_작은_이미지는_늘리지_않는다() -> None:
    """없는 화소를 만들어 선명하다고 우기지 않는다 — 작은 입력은 그대로 잰다."""
    small = _detailed_image(64, 64)
    assert scaled_blur_score(small) == scaled_blur_score(small, target_h=SHARPNESS_HEIGHT)


def test_빈_이미지는_0() -> None:
    assert scaled_blur_score(np.zeros((0, 0), dtype=np.uint8)) == 0.0
