"""
얼굴 검출 결과로부터 신체 영역을 추정한다.

**왜 추정하는가**
전용 인물 검출기(RTMDet 등)를 아직 도입하지 않았으므로, 얼굴 bbox에서
인체 비례를 이용해 신체 영역을 유도한다. 성인 기준 머리 높이는 전신의
약 1/7.5이고 어깨 너비는 얼굴 너비의 약 2.5~3배라는 표준 비례를 쓴다.

**한계 (명시)**
  · 앉은 자세, 심한 원근, 극단적 포즈에서 어긋난다
  · 얼굴이 검출되지 않으면 신체 영역도 얻을 수 없다 — 후면 인물은 누락된다
  · 프레임 경계에서 잘리면 밴드 비율이 왜곡된다

이 한계는 인물 검출기를 붙이면 사라진다. `person_bbox()` 인터페이스를
그대로 두고 구현만 교체하면 되도록 분리했다.
"""
from __future__ import annotations

from dataclasses import dataclass

# 인체 비례 상수 — 머리 높이 대비 전신, 얼굴 너비 대비 어깨 너비
BODY_HEIGHT_PER_FACE = 7.0
BODY_WIDTH_PER_FACE = 3.0
# 얼굴 위쪽으로 정수리 여유
HEAD_MARGIN_PER_FACE = 0.35


@dataclass(frozen=True)
class Region:
    x: int
    y: int
    w: int
    h: int

    @property
    def is_valid(self) -> bool:
        return self.w > 4 and self.h > 8


def person_region(
    face_x: float, face_y: float, face_w: float, face_h: float,
    frame_w: int, frame_h: int,
) -> Region:
    """얼굴 bbox → 신체 영역(프레임 경계로 클립)."""
    cx = face_x + face_w / 2.0

    width = face_w * BODY_WIDTH_PER_FACE
    top = face_y - face_h * HEAD_MARGIN_PER_FACE
    height = face_h * BODY_HEIGHT_PER_FACE

    x0 = int(max(0, cx - width / 2.0))
    y0 = int(max(0, top))
    x1 = int(min(frame_w, cx + width / 2.0))
    y1 = int(min(frame_h, top + height))

    return Region(x=x0, y=y0, w=max(0, x1 - x0), h=max(0, y1 - y0))


def crop(image, region: Region):
    """영역을 잘라낸다. 유효하지 않으면 None."""
    if not region.is_valid:
        return None
    sub = image[region.y:region.y + region.h, region.x:region.x + region.w]
    return sub if sub.size > 0 else None
