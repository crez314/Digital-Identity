"""
인코더 동작 검증 — 요구사항 §22의 필수 테스트 5종.

실제 가중치로 실추론을 돌리므로, 가중치가 없는 환경(CI의 mock 모드 등)에서는
건너뛴다. 건너뛴 사실이 보고되므로 "테스트가 통과했다"와 "테스트가 돌지 않았다"를
혼동하지 않는다.

임계값 근거는 outputs/discrimination_report.json의 실측 분포다.
  동일인 쌍 78건  평균 0.7954  범위 0.6361~0.9865
  타인   쌍 13건  평균 0.1434  범위 0.0752~0.2228
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from app.encoders.base import EncoderUnavailable
from app.encoders.registry import body_encoder, face_encoder

FIXTURES = Path(__file__).parent / "fixtures"

# 실측 분포에서 유도한 경계. 동일인 최솟값 0.6361, 타인 최댓값 0.2228 사이.
SAME_PERSON_FLOOR = 0.55
DIFFERENT_PERSON_CEILING = 0.40


def _encoders():
    # 인코더는 ML_MODE와 무관하다 — 레지스트리가 설정과 가중치만 본다.
    # 둘 중 하나라도 없으면 '실행 못 함'이므로 실패가 아니라 skip이다.
    try:
        fe = face_encoder()
        be = body_encoder()
    except (EncoderUnavailable, FileNotFoundError, OSError) as e:
        pytest.skip(f"인코더 사용 불가: {e}")
    return fe, be


@pytest.fixture(scope="module")
def face_enc():
    fe, _ = _encoders()
    img = cv2.imread(str(FIXTURES / "person_a.jpg"))
    if img is None:
        pytest.skip("픽스처 없음")
    try:
        if not fe.encode(img).ok:
            pytest.skip("얼굴 검출 실패 — 가중치 확인 필요")
    except (EncoderUnavailable, FileNotFoundError, OSError) as e:
        pytest.skip(f"가중치 없음: {e}")
    return fe


@pytest.fixture(scope="module")
def body_enc():
    _, be = _encoders()
    return be


def _load(name: str) -> np.ndarray:
    img = cv2.imread(str(FIXTURES / name))
    if img is None:
        pytest.skip(f"픽스처 없음: {name}")
    return img


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    return float(np.dot(a, b) / (na * nb)) if na and nb else 0.0


# ── §22-1 같은 이미지 비교 → 높은 Face Similarity ──────────
def test_same_image_gives_maximum_similarity(face_enc):
    img = _load("person_a.jpg")
    v1 = face_enc.encode(img).vector
    v2 = face_enc.encode(img).vector
    assert cosine(v1, v2) == pytest.approx(1.0, abs=1e-5)


# ── §22-2 다른 사람 비교 → 낮은 Face Similarity ────────────
def test_different_person_gives_low_similarity(face_enc):
    """
    가장 중요한 검증. 이것이 성립하지 않으면 신원 점수 자체가 무의미하다.
    두 인물은 같은 인구통계(젊은 한국인 여성)로 골라 난이도를 높였다.
    """
    a = face_enc.encode(_load("person_a.jpg"))
    c = face_enc.encode(_load("person_c.jpg"))
    assert a.ok and c.ok, "두 픽스처 모두에서 얼굴이 검출되어야 한다"

    sim = cosine(a.vector, c.vector)
    assert sim < DIFFERENT_PERSON_CEILING, (
        f"타인 유사도 {sim:.4f}가 너무 높다. 실측 타인 분포 상한은 0.2228이었다."
    )


def test_same_person_and_different_person_are_separable(face_enc):
    """동일인 하한이 타인 상한보다 확실히 위에 있어야 판정이 성립한다."""
    a1 = face_enc.encode(_load("person_a.jpg")).vector
    a2 = face_enc.encode(_load("person_a_outfit2.jpg")).vector   # 같은 얼굴, 다른 의상
    c = face_enc.encode(_load("person_c.jpg")).vector

    same = cosine(a1, a2)
    diff = cosine(a1, c)
    assert same > SAME_PERSON_FLOOR, f"동일인 유사도가 낮다: {same:.4f}"
    assert diff < DIFFERENT_PERSON_CEILING, f"타인 유사도가 높다: {diff:.4f}"
    assert same - diff > 0.3, f"분리 마진이 부족하다: {same - diff:.4f}"


# ── §22-3 같은 사람 / 다른 의상 → Body metric 변화 ─────────
def test_clothing_change_moves_body_but_not_face(face_enc, body_enc):
    """
    신체 지표가 얼굴의 파생물이 아님을 확인한다.
    얼굴을 건드리지 않고 하체 의상만 바꿨을 때 신체만 반응해야 한다.
    """
    a1 = _load("person_a.jpg")
    a2 = _load("person_a_outfit2.jpg")

    face_sim = cosine(face_enc.encode(a1).vector, face_enc.encode(a2).vector)
    body_sim = cosine(body_enc.encode(a1).vector, body_enc.encode(a2).vector)

    assert face_sim > 0.95, f"얼굴은 유지되어야 한다: {face_sim:.4f}"
    assert body_sim < face_sim, (
        f"신체가 의상 변화에 반응하지 않는다 (face {face_sim:.4f} / body {body_sim:.4f}). "
        "신체 지표가 얼굴을 복사하고 있는지 확인할 것."
    )


def test_body_encoder_is_independent_of_face(face_enc, body_enc):
    """두 벡터가 서로의 파생물이 아닌지 상관으로 확인한다."""
    img = _load("person_a.jpg")
    f = face_enc.encode(img).vector[:256]
    b = body_enc.encode(img).vector
    corr = abs(cosine(f, b))
    assert corr < 0.5, f"얼굴·신체 벡터 상관이 지나치게 높다: {corr:.4f}"


# ── §22-4 연속 동일 frame → Temporal Delta ≈ 0 ─────────────
def test_identical_consecutive_frames_have_zero_delta(face_enc, body_enc):
    img = _load("person_a.jpg")
    f_delta = 1.0 - cosine(face_enc.encode(img).vector, face_enc.encode(img).vector)
    b_delta = 1.0 - cosine(body_enc.encode(img).vector, body_enc.encode(img).vector)
    assert abs(f_delta) < 1e-5
    assert abs(b_delta) < 1e-5


# ── §22-5 갑작스러운 다른 identity 삽입 → Drift 발생 ────────
def test_identity_switch_produces_large_delta(face_enc):
    """
    같은 인물이 이어지다 다른 인물 프레임이 끼어들면, 그 지점의
    frame-to-frame 변화량이 정상 구간보다 확연히 커져야 한다.
    이 신호가 커지지 않으면 drift 검출이 성립하지 않는다.
    """
    a1 = face_enc.encode(_load("person_a.jpg")).vector
    a2 = face_enc.encode(_load("person_a_outfit2.jpg")).vector
    c = face_enc.encode(_load("person_c.jpg")).vector

    normal_delta = 1.0 - cosine(a1, a2)      # 동일인 연속
    switch_delta = 1.0 - cosine(a2, c)       # 타인으로 전환

    assert switch_delta > normal_delta * 3, (
        f"identity 전환 지점의 변화량이 충분히 크지 않다 "
        f"(정상 {normal_delta:.4f} / 전환 {switch_delta:.4f})"
    )
    assert switch_delta > 0.5, f"전환 변화량이 절대적으로도 커야 한다: {switch_delta:.4f}"


# ── 인코더 계약 ────────────────────────────────────────────
def test_encoders_report_license_track(face_enc, body_enc):
    """산출물에 어떤 트랙의 인코더를 썼는지 남아야 한다."""
    for enc in (face_enc, body_enc):
        bundle = enc.info.as_bundle()
        assert bundle["track"] in ("production", "research")
        assert bundle["weightsLicense"]


def test_vectors_are_l2_normalized(face_enc, body_enc):
    """정규화를 보장해야 코사인 유사도를 내적으로 계산할 수 있다."""
    img = _load("person_a.jpg")
    for enc in (face_enc, body_enc):
        v = enc.encode(img).vector
        assert float(np.linalg.norm(v)) == pytest.approx(1.0, abs=1e-4)
