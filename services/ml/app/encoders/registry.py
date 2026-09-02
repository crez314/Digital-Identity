"""
인코더 레지스트리 — 설정 파일로 인코더를 선택한다.

모델 경로를 코드에 하드코딩하지 않는다. `configs/encoders.yaml`이 단일 출처이며,
환경변수 `CREZ_ENCODER_CONFIG`로 다른 설정을 지정할 수 있다.
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path

import yaml

from .base import BodyEncoder, EncoderUnavailable, FaceEncoder, LicenseTrack

log = logging.getLogger(__name__)

DEFAULT_CONFIG = Path(__file__).resolve().parents[2] / "configs" / "encoders.yaml"


@lru_cache
def load_config() -> dict:
    path = Path(os.environ.get("CREZ_ENCODER_CONFIG", str(DEFAULT_CONFIG)))
    if not path.exists():
        raise FileNotFoundError(f"인코더 설정을 찾을 수 없습니다: {path}")
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _allow_research() -> bool:
    """
    research 트랙 인코더는 명시적으로 켜야 쓸 수 있다.
    실수로 production에서 연구 전용 가중치가 사용되는 것을 막는다.
    """
    return os.environ.get("CREZ_ALLOW_RESEARCH_ENCODERS", "").lower() in ("1", "true", "yes")


def _build(spec: dict, kind: str):
    impl = spec["impl"]
    params = spec.get("params", {}) or {}

    if impl == "sface":
        from .sface import SFaceEncoder
        return SFaceEncoder(**params)
    if impl == "body_appearance":
        from .body_appearance import AppearanceBodyEncoder
        return AppearanceBodyEncoder(**params)

    # ── research 트랙 — 기본 미설치, 명시적 허용 필요 ──
    if impl in ("adaface", "osnet", "fastreid"):
        if not _allow_research():
            raise EncoderUnavailable(
                f"'{impl}'은 research 트랙 인코더입니다. 가중치가 연구 전용이므로 "
                f"production 사용이 불가하며, 실험 목적일 때만 "
                f"CREZ_ALLOW_RESEARCH_ENCODERS=1 로 활성화하십시오."
            )
        if impl == "adaface":
            from .research.adaface import AdaFaceEncoder
            return AdaFaceEncoder(**params)
        if impl == "osnet":
            from .research.osnet import OSNetEncoder
            return OSNetEncoder(**params)
        from .research.fastreid import FastReIDEncoder
        return FastReIDEncoder(**params)

    raise EncoderUnavailable(f"알 수 없는 {kind} 인코더: {impl}")


def face_encoder(name: str | None = None) -> FaceEncoder:
    cfg = load_config()
    key = name or os.environ.get("CREZ_FACE_ENCODER") or cfg["face"]["default"]
    spec = cfg["face"]["encoders"][key]
    return _build(spec, "face")


def body_encoder(name: str | None = None) -> BodyEncoder:
    cfg = load_config()
    key = name or os.environ.get("CREZ_BODY_ENCODER") or cfg["body"]["default"]
    spec = cfg["body"]["encoders"][key]
    return _build(spec, "body")


def available(kind: str) -> dict[str, dict]:
    """설정에 선언된 인코더 목록과 트랙 정보."""
    cfg = load_config()
    out = {}
    for key, spec in cfg[kind]["encoders"].items():
        track = spec.get("track", "production")
        out[key] = {
            "impl": spec["impl"],
            "track": track,
            "usable": track == LicenseTrack.PRODUCTION.value or _allow_research(),
        }
    return out
