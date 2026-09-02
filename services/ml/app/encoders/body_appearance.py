"""
외형 기반 신체 인코더 (production 트랙) — CREZ 자체 구현.

**왜 필요한가**
얼굴이 보이지 않는 프레임(후면·측면·원거리·모션블러)에서도 신원 단서가 필요하다.
얼굴 벡터의 파생물은 그 목적을 달성할 수 없으므로, 이 인코더는 얼굴 정보를
전혀 사용하지 않는 독립 신호여야 한다.

**무엇을 인코딩하는가**
사람 crop을 세로 4개 밴드(머리·상의·하의·다리)로 나누고 밴드별로
  · HSV 색분포 (의상 색상·채도)
  · 그래디언트 방향 분포 (무늬·질감)
를 뽑아 밴드별로 정규화한 뒤 결합한다. 밴드를 나누는 이유는 상의와 하의를
구분하지 않으면 "흰 상의+검은 바지"와 "검은 상의+흰 바지"가 같은 벡터가 되기 때문이다.

**한계 (명시)**
전용 Re-ID 가중치가 아니므로 조명 변화와 의상 교체에 약하다. 동일 인물이
옷을 갈아입으면 유사도가 크게 떨어진다. 신원의 보조 신호로만 쓰고,
가중치를 얼굴보다 낮게 두는 것이 전제다(§10 ruleset).
전용 ReID 인코더로 교체할 수 있도록 인터페이스를 분리해 두었다.
"""
from __future__ import annotations

import cv2
import numpy as np

from .base import BodyEncoder, EncodeResult, EncoderInfo, LicenseTrack

# 세로 밴드 경계 (비율). 머리 / 상의 / 하의 / 다리
BANDS = ((0.00, 0.20), (0.20, 0.50), (0.50, 0.72), (0.72, 1.00))


class AppearanceBodyEncoder(BodyEncoder):
    def __init__(self, dim: int = 256, bins: int = 16):
        # 기술자 크기 = 밴드수 × bins × 4(H·S·V·질감).
        # 기본값은 4 × 16 × 4 = 256으로 DB의 body vector(256)에 정확히 맞는다.
        self._dim = dim
        self._bins = bins

    @property
    def info(self) -> EncoderInfo:
        return EncoderInfo(
            name="crez-appearance", version="1.0", dim=self._dim,
            track=LicenseTrack.PRODUCTION,
            weights_source="가중치 없음 — 결정론적 특징 산출",
            weights_license="N/A (CREZ 자체 구현)",
            notes="밴드별 HSV + 그래디언트 방향 히스토그램. 의상 교체에 취약.",
        )

    def _band_feature(self, band: np.ndarray) -> np.ndarray:
        """한 밴드의 색·질감 특징."""
        if band.size == 0:
            return np.zeros(self._bins * 4, dtype=np.float32)

        hsv = cv2.cvtColor(band, cv2.COLOR_BGR2HSV)
        parts: list[np.ndarray] = []

        # 색상·채도·명도 분포. 채도가 낮은 화소는 색상이 불안정하므로 마스크로 제외한다.
        sat = hsv[:, :, 1]
        mask = (sat > 40).astype(np.uint8)
        for ch, rng in ((0, 180), (1, 256), (2, 256)):
            m = mask if ch == 0 else None
            hist = cv2.calcHist([hsv], [ch], m, [self._bins], [0, rng]).ravel()
            s = hist.sum()
            parts.append(hist / s if s > 0 else hist)

        # 질감 — 그래디언트 방향 분포로 무늬/줄무늬를 구분한다
        gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
        gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        mag = cv2.magnitude(gx, gy)
        ang = (np.rad2deg(np.arctan2(gy, gx)) + 180.0) % 180.0
        tex, _ = np.histogram(ang, bins=self._bins, range=(0, 180), weights=mag)
        s = tex.sum()
        parts.append((tex / s if s > 0 else tex).astype(np.float32))

        return np.concatenate(parts).astype(np.float32)

    def encode(self, image: np.ndarray) -> EncodeResult:
        if image is None or image.size == 0:
            return EncodeResult(ok=False, error="빈 이미지")

        h = image.shape[0]
        if h < 8:
            return EncodeResult(ok=False, error="crop이 너무 작다")

        feats = []
        for lo, hi in BANDS:
            band = image[int(h * lo):int(h * hi)]
            # 밴드별로 개별 정규화한다 — 한 밴드의 강한 색이 전체를 지배하지 않게
            f = self._band_feature(band)
            n = float(np.linalg.norm(f))
            feats.append(f / n if n > 0 else f)

        v = np.concatenate(feats).astype(np.float32)

        # 절단은 하지 않는다. 벡터를 자르면 뒤쪽 밴드(하의·다리)가 통째로 사라져
        # 하체 의상 변화를 전혀 감지하지 못하게 된다. 부족하면 0으로 채우고,
        # 넘치면 설정 오류이므로 조용히 버리는 대신 명시적으로 실패시킨다.
        if v.size > self._dim:
            raise ValueError(
                f"기술자 차원 {v.size}가 설정 dim {self._dim}보다 큽니다. "
                f"bins를 {self._dim // (len(BANDS) * 4)} 이하로 낮추거나 dim을 키우십시오."
            )
        if v.size < self._dim:
            padded = np.zeros(self._dim, dtype=np.float32)
            padded[:v.size] = v
            v = padded

        # 선명도로 품질을 매긴다 — 흐린 crop의 색분포는 신뢰도가 낮다
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        quality = float(min(1.0, sharp / 300.0))

        return EncodeResult(
            ok=True, vector=self.l2_normalize(v), quality=quality,
            meta={"bands": len(BANDS), "cropHeight": int(h)},
        )
