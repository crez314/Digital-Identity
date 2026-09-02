"""
다중 인물 트래킹 — §7 /v1/video/analyze.

ByteTrack(MIT) 방식을 따른다: 고신뢰 검출로 먼저 연결하고, 남은 트랙을
저신뢰 검출과 다시 매칭해 가림 구간에서 트랙이 끊기는 것을 줄인다.
가중치 파일이 필요 없는 알고리즘 계층이므로 라이선스 리스크가 없다.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linear_sum_assignment

HIGH_THRESHOLD = 0.6
LOW_THRESHOLD = 0.25
IOU_MATCH = 0.3
MAX_LOST_FRAMES = 15  # 이 프레임 수를 넘겨 소실되면 트랙을 종료한다(§9.2 완전 가림 후 재등장 → 분절)


def iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = aw * ah + bw * bh - inter
    return float(inter / union) if union > 0 else 0.0


@dataclass
class Detection:
    bbox: tuple[float, float, float, float]
    score: float
    ms: int
    face_vector: list[float] | None = None
    face_quality: float | None = None
    landmarks: list[list[float]] | None = None
    body_vector: list[float] | None = None


@dataclass
class Track:
    track_index: int
    frames: list[dict] = field(default_factory=list)
    last_bbox: tuple[float, float, float, float] = (0, 0, 0, 0)
    lost: int = 0
    active: bool = True

    @property
    def start_ms(self) -> int:
        return self.frames[0]["ms"] if self.frames else 0

    @property
    def end_ms(self) -> int:
        return self.frames[-1]["ms"] if self.frames else 0


class ByteTrackStyleTracker:
    def __init__(self, max_persons: int = 10):
        self.tracks: list[Track] = []
        self.next_index = 0
        self.max_persons = max_persons

    def _associate(self, tracks: list[Track], dets: list[Detection]) -> list[tuple[int, int]]:
        if not tracks or not dets:
            return []
        cost = np.ones((len(tracks), len(dets)), dtype=np.float32)
        for i, t in enumerate(tracks):
            for j, d in enumerate(dets):
                cost[i, j] = 1.0 - iou(t.last_bbox, d.bbox)
        rows, cols = linear_sum_assignment(cost)
        return [(int(r), int(c)) for r, c in zip(rows, cols) if cost[r, c] <= 1.0 - IOU_MATCH]

    def update(self, detections: list[Detection], ms: int) -> None:
        high = [d for d in detections if d.score >= HIGH_THRESHOLD]
        low = [d for d in detections if LOW_THRESHOLD <= d.score < HIGH_THRESHOLD]

        active = [t for t in self.tracks if t.active]
        matched_tracks: set[int] = set()
        matched_dets: set[int] = set()

        # 1단계 — 고신뢰 검출
        for ti, di in self._associate(active, high):
            self._attach(active[ti], high[di], ms)
            matched_tracks.add(id(active[ti]))
            matched_dets.add(di)

        # 2단계 — 남은 트랙을 저신뢰 검출과 매칭 (가림 구간 보존)
        remaining = [t for t in active if id(t) not in matched_tracks]
        for ti, di in self._associate(remaining, low):
            self._attach(remaining[ti], low[di], ms, occluded=True)
            matched_tracks.add(id(remaining[ti]))

        # 미매칭 트랙은 lost 카운트를 올린다
        for t in active:
            if id(t) not in matched_tracks:
                t.lost += 1
                if t.lost > MAX_LOST_FRAMES:
                    t.active = False

        # 미매칭 고신뢰 검출은 새 트랙으로
        for di, d in enumerate(high):
            if di in matched_dets:
                continue
            if len([t for t in self.tracks if t.active]) >= self.max_persons:
                break
            track = Track(track_index=self.next_index)
            self.next_index += 1
            self._attach(track, d, ms)
            self.tracks.append(track)

    def _attach(self, track: Track, det: Detection, ms: int, occluded: bool = False) -> None:
        track.last_bbox = det.bbox
        track.lost = 0
        track.frames.append({
            "ms": ms,
            "bbox": {"x": det.bbox[0], "y": det.bbox[1], "w": det.bbox[2], "h": det.bbox[3]},
            "keypoints": None,
            "faceQuality": det.face_quality,
            "faceVector": det.face_vector,
            "bodyVector": det.body_vector,
            "occlusion": 0.7 if occluded else 0.0,
        })

    def finish(self, top_k: int = 20) -> list[dict]:
        """트랙별 대표 임베딩 = 상위 품질 프레임의 trimmed mean (§9.2)."""
        out: list[dict] = []
        for t in self.tracks:
            if not t.frames:
                continue
            vecs = [(f["faceQuality"] or 0.0, f["faceVector"]) for f in t.frames if f.get("faceVector")]
            vecs.sort(key=lambda x: -x[0])
            top = [v for _, v in vecs[:top_k]]
            centroid = None
            if top:
                mat = np.array(top, dtype=np.float32)
                # trimmed mean — 상·하위 10%를 잘라 이상 프레임의 영향을 줄인다
                if len(mat) >= 5:
                    trim = max(1, len(mat) // 10)
                    order = np.argsort(np.linalg.norm(mat - mat.mean(axis=0), axis=1))
                    mat = mat[order[: len(mat) - trim]]
                c = mat.mean(axis=0)
                n = float(np.linalg.norm(c))
                centroid = (c / n).astype(float).tolist() if n > 0 else c.astype(float).tolist()

            qualities = [f["faceQuality"] or 0.0 for f in t.frames]
            out.append({
                "trackIndex": t.track_index,
                "startMs": t.start_ms,
                "endMs": t.end_ms,
                "faceCentroid": centroid,
                "bodyCentroid": None,
                "quality": float(np.mean(qualities)) if qualities else 0.0,
                "frameCount": len(t.frames),
                "frames": t.frames,
            })
        return out
