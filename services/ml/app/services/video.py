"""영상 디코드·샘플링과 프레임 추출 — §7 /v1/video/analyze, /v1/media/frames."""
from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from ..config import settings
from . import face as face_svc
from . import models, storage
from .imaging import frontality, quality_score
from .mock import seeded_float, seeded_vector
from .tracking import ByteTrackStyleTracker, Detection

log = logging.getLogger(__name__)


def open_video(key: str) -> tuple[cv2.VideoCapture, Path, dict]:
    path = storage.download(key, suffix=".mp4")
    cap = cv2.VideoCapture(str(path))
    meta = {
        "fps": float(cap.get(cv2.CAP_PROP_FPS) or 30.0),
        "frameCount": int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0),
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
    }
    meta["durationMs"] = int((meta["frameCount"] / meta["fps"]) * 1000) if meta["fps"] else 0
    return cap, path, meta


def sample_frames(cap: cv2.VideoCapture, meta: dict, sample_fps: float):
    """sample_fps 간격으로 프레임을 순회한다. 상한을 둬 장시간 영상에서도 메모리가 안전하다."""
    step = max(1, round(meta["fps"] / max(sample_fps, 0.1)))
    limit = settings().max_sampled_frames
    idx = 0
    yielded = 0
    while yielded < limit:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            ms = int((idx / meta["fps"]) * 1000) if meta["fps"] else 0
            yield ms, frame
            yielded += 1
        idx += 1


def _mock_tracks(video_key: str, duration_ms: int, sample_fps: float, persons: int = 2) -> list[dict]:
    """결정론적 mock 트랙 — 프론트엔드·파이프라인 개발용(§18)."""
    step = int(1000 / max(sample_fps, 0.1))
    tracks = []
    for p in range(persons):
        frames = []
        for ms in range(0, max(duration_ms, step), step):
            frames.append({
                "ms": ms,
                "bbox": {"x": 100.0 + p * 300, "y": 80.0, "w": 180.0, "h": 220.0},
                "keypoints": None,
                "faceQuality": seeded_float(f"{video_key}:{p}:{ms}:q", 0.5, 0.95),
                "faceVector": seeded_vector(f"{video_key}:{p}", models.FACE_STORAGE_DIM),
                "occlusion": 0.0,
            })
        tracks.append({
            "trackIndex": p,
            "startMs": 0,
            "endMs": frames[-1]["ms"] if frames else 0,
            "faceCentroid": seeded_vector(f"{video_key}:{p}", models.FACE_STORAGE_DIM),
            "bodyCentroid": None,
            "quality": 0.8,
            "frameCount": len(frames),
            "frames": frames,
        })
    return tracks


def analyze(video_key: str, sample_fps: float = 5, max_persons: int = 10) -> dict:
    """인물 검출 → 트래킹 → 트랙별 대표 임베딩 (§9.1 1–2단계)."""
    if models.is_mock():
        duration = 10000
        return {
            "videoKey": video_key, "durationMs": duration, "fps": 30.0,
            "width": 1920, "height": 1080,
            "tracks": _mock_tracks(video_key, duration, sample_fps),
            "modelBundle": models.bundle(),
        }

    cap, path, meta = open_video(video_key)
    try:
        tracker = ByteTrackStyleTracker(max_persons=max_persons)
        recognizer = models.face_recognizer()

        for ms, frame in sample_frames(cap, meta, sample_fps):
            detections: list[Detection] = []
            for row, score in face_svc.detect_faces(frame):
                x, y, w, h = [float(v) for v in row[:4]]
                landmarks = np.array(row[4:14], dtype=np.float32).reshape(5, 2)
                try:
                    aligned = recognizer.alignCrop(frame, row)
                    feature = models.pad_to_storage_dim(recognizer.feature(aligned))
                except Exception:  # noqa: BLE001 — 정렬 실패 프레임은 벡터 없이 트랙 연속성만 유지
                    feature = None

                x0, y0 = max(0, int(x)), max(0, int(y))
                crop = frame[y0 : y0 + int(h), x0 : x0 + int(w)]
                gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.size else np.zeros((1, 1), np.uint8)
                front = frontality(landmarks)
                detections.append(Detection(
                    bbox=(x, y, w, h), score=score, ms=ms,
                    face_vector=feature,
                    face_quality=quality_score(gray, h, meta["height"], front),
                    landmarks=landmarks.tolist(),
                ))
            tracker.update(detections, ms)

        return {
            "videoKey": video_key,
            "durationMs": meta["durationMs"],
            "fps": meta["fps"],
            "width": meta["width"],
            "height": meta["height"],
            "tracks": tracker.finish(),
            "modelBundle": models.bundle(),
        }
    finally:
        cap.release()
        path.unlink(missing_ok=True)


def extract_frames(video_key: str, timestamps_ms: list[int], output_prefix: str) -> list[dict]:
    """finding 근거 썸네일 추출 (§10.2)."""
    if models.is_mock():
        return [{"ms": ms, "key": f"{output_prefix}/{ms}.jpg"} for ms in timestamps_ms]

    cap, path, _meta = open_video(video_key)
    out: list[dict] = []
    try:
        for ms in timestamps_ms:
            cap.set(cv2.CAP_PROP_POS_MSEC, float(ms))
            ok, frame = cap.read()
            if not ok:
                continue
            ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
            if not ok:
                continue
            key = f"{output_prefix}/{ms}.jpg"
            storage.upload_bytes(key, buf.tobytes(), "image/jpeg")
            out.append({"ms": ms, "key": key})
    finally:
        cap.release()
        path.unlink(missing_ok=True)
    return out
