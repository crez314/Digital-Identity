"""
§18: GPU가 없는 개발 머신에서 crez-ml을 고정 응답 mock으로 실행할 수 있어야 한다.
프론트엔드 개발자가 GPU 없이 전체 플로우를 돌리는 데 필수다.

mock은 무작위가 아니라 키 기반 결정론적 값을 낸다 — 같은 입력이면 같은 결과여야
파이프라인 테스트가 재현 가능하다.
"""
from __future__ import annotations

import hashlib

import numpy as np


def seeded_vector(seed: str, dim: int) -> list[float]:
    h = hashlib.sha256(seed.encode()).digest()
    rng = np.random.default_rng(int.from_bytes(h[:8], "big"))
    v = rng.normal(size=dim).astype(np.float32)
    v /= np.linalg.norm(v) or 1.0
    return v.tolist()


def seeded_float(seed: str, low: float = 0.0, high: float = 1.0) -> float:
    h = hashlib.sha256(seed.encode()).digest()
    x = int.from_bytes(h[8:12], "big") / 0xFFFFFFFF
    return float(low + (high - low) * x)
