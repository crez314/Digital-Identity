"""
아티팩트 검출 — §7 /v1/qc/artifact.
손·얼굴 아티팩트, 플리커, 프레임 이상 구간을 찾는다. 판정은 하지 않는다.
"""
from __future__ import annotations

import cv2
import numpy as np

from . import models
from .imaging import blur_score
from .mock import seeded_float
from .video import open_video, sample_frames


def detect(video_key: str, sample_fps: float = 5) -> dict:
    if models.is_mock():
        return {
            "videoKey": video_key,
            "spans": [] if seeded_float(f"art:{video_key}") < 0.7 else [
                {"kind": "FACE_ARTIFACT", "startMs": 2000, "endMs": 2600, "score": 0.62, "frameIndices": [2000, 2200, 2400]}
            ],
            "modelBundle": models.bundle(),
        }

    cap, path, meta = open_video(video_key)
    try:
        prev_gray: np.ndarray | None = None
        sharpness: list[tuple[int, float]] = []
        flow_mags: list[tuple[int, float]] = []

        for ms, frame in sample_frames(cap, meta, sample_fps):
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            small = cv2.resize(gray, (160, 90))
            sharpness.append((ms, blur_score(small)))
            if prev_gray is not None:
                # 프레임 간 밝기 변화량 — 급등이 반복되면 플리커로 본다
                diff = float(np.abs(small.astype(np.int16) - prev_gray.astype(np.int16)).mean()) / 255.0
                flow_mags.append((ms, diff))
            prev_gray = small

        spans: list[dict] = []

        # TEMPORAL_FLICKER — 변화량 z-score 급등 구간
        if len(flow_mags) >= 8:
            vals = np.array([v for _, v in flow_mags], dtype=np.float32)
            mean, sd = float(vals.mean()), float(vals.std())
            if sd > 0:
                spikes = [flow_mags[i][0] for i in range(len(vals)) if (vals[i] - mean) / sd > 2.5]
                if len(spikes) >= 3:
                    spans.append({
                        "kind": "TEMPORAL_FLICKER",
                        "startMs": spikes[0], "endMs": spikes[-1],
                        "score": float(min(1.0, len(spikes) / max(len(vals) * 0.2, 1))),
                        "frameIndices": spikes[:20],
                    })

        # FRAME_ANOMALY — 선명도가 극단적으로 떨어지는 구간(생성 붕괴 후보)
        if sharpness:
            svals = np.array([v for _, v in sharpness], dtype=np.float32)
            median = float(np.median(svals))
            bad = [ms for ms, v in sharpness if v < median * 0.35]
            if len(bad) >= 3:
                spans.append({
                    "kind": "FRAME_ANOMALY",
                    "startMs": bad[0], "endMs": bad[-1],
                    "score": float(min(1.0, len(bad) / max(len(svals) * 0.2, 1))),
                    "frameIndices": bad[:20],
                })

        return {"videoKey": video_key, "spans": spans, "modelBundle": models.bundle()}
    finally:
        cap.release()
        path.unlink(missing_ok=True)
