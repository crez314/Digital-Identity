"""
인코더 인터페이스 — CREZ 자체 계층과 외부 모델의 경계.

**설계 의도 (특허 관점)**
외부 모델은 특징 추출기(Feature Extractor) 역할만 수행한다. 발명의 중심은
추출된 벡터를 어떻게 비교·누적·판정하는가에 있으므로, 어떤 인코더를 쓰든
상위 계층(집계·시간일관성·드리프트·융합)이 동일하게 동작해야 한다.

이 인터페이스가 그 경계다. 인코더를 교체해도 CREZ 계층은 바뀌지 않는다.

**라이선스 트랙 분리**
`track` 속성이 인코더의 상업 이용 가능 여부를 선언한다.
  - PRODUCTION : 가중치까지 상업 이용이 명시적으로 허용된 인코더
  - RESEARCH   : 코드는 퍼미시브이나 가중치가 연구 전용인 인코더
RESEARCH 인코더는 기본 설치·기본 선택 대상이 아니며, production 빌드에
포함되면 CI 라이선스 스캐너가 빌드를 실패시킨다.
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum

import numpy as np

log = logging.getLogger(__name__)


class LicenseTrack(str, Enum):
    PRODUCTION = "production"
    RESEARCH = "research"


@dataclass(frozen=True)
class EncoderInfo:
    """재현성을 위해 모든 결과에 동반되는 인코더 신원 정보."""
    name: str
    version: str
    dim: int
    track: LicenseTrack
    weights_source: str
    weights_license: str
    notes: str = ""

    def as_bundle(self) -> dict:
        return {
            "name": self.name, "version": self.version, "dim": self.dim,
            "track": self.track.value, "weightsSource": self.weights_source,
            "weightsLicense": self.weights_license,
        }


@dataclass
class EncodeResult:
    """
    인코딩 1건의 결과.

    vector는 L2 정규화된 상태로 반환한다 — 코사인 유사도를 내적으로 계산할 수 있고,
    이후 집계·비교 단계가 정규화 여부를 신경 쓰지 않아도 된다.
    """
    ok: bool
    vector: np.ndarray | None = None
    quality: float | None = None
    error: str | None = None
    meta: dict = field(default_factory=dict)


class Encoder(ABC):
    """모든 인코더의 공통 계약."""

    @property
    @abstractmethod
    def info(self) -> EncoderInfo: ...

    @abstractmethod
    def encode(self, image: np.ndarray) -> EncodeResult:
        """BGR 이미지 한 장 → 특징 벡터."""

    def encode_batch(self, images: list[np.ndarray]) -> list[EncodeResult]:
        """기본은 순차 처리. GPU 인코더는 실제 배치로 재정의한다."""
        return [self.encode(img) for img in images]

    @staticmethod
    def l2_normalize(v: np.ndarray) -> np.ndarray:
        v = np.asarray(v, dtype=np.float32).ravel()
        n = float(np.linalg.norm(v))
        return v / n if n > 0 else v


class FaceEncoder(Encoder):
    """
    얼굴 특징 추출기.

    입력은 이미 정렬(align)된 얼굴 crop이거나 전체 프레임일 수 있다.
    구현체가 내부적으로 검출·정렬을 수행할지 결정한다.
    """


class BodyEncoder(Encoder):
    """
    신체 특징 추출기 (Person Re-ID).

    얼굴이 보이지 않는 프레임(후면·측면·원거리)에서 신원 단서를 제공하는 것이 목적이다.
    따라서 얼굴 벡터의 파생물이어서는 안 된다 — 독립적인 신호여야 의미가 있다.
    """


class EncoderUnavailable(RuntimeError):
    """인코더가 설치되지 않았거나 가중치가 없을 때."""
