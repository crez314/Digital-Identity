"""
QC 점수 산출 — §7 /v1/qc/score, §10.1 지표 정의.

**합격 여부를 판단하지 않는다.** 점수와 프레임 단위 원시 시계열만 반환하고,
임계값 적용과 finding 생성은 crez-api의 QC 규칙 엔진이 담당한다(§7, §2.2).
"""
from __future__ import annotations

import logging

import numpy as np

from . import models, storage
from .imaging import cosine
from .mock import seeded_float
from .video import analyze as analyze_video

log = logging.getLogger(__name__)


def _temporal_consistency(deltas: list[float]) -> float:
    """인접 유효 프레임 간 임베딩 변화량의 역수 정규화. 값이 튀면 하락한다(§10.1)."""
    if not deltas:
        return 1.0
    mean_delta = float(np.mean(deltas))
    return float(max(0.0, min(1.0, 1.0 / (1.0 + mean_delta * 10.0))))


def _dtw_distance(a: np.ndarray, b: np.ndarray) -> float:
    """
    motion_consistency용 DTW (§10.1). 시퀀스가 길면 비용이 커지므로
    다운샘플 후 밴드 제약(Sakoe-Chiba) 없이 단순 DP로 계산한다.
    """
    n, m = len(a), len(b)
    if n == 0 or m == 0:
        return float("inf")
    max_len = 200
    if n > max_len:
        a = a[np.linspace(0, n - 1, max_len).astype(int)]
        n = max_len
    if m > max_len:
        b = b[np.linspace(0, m - 1, max_len).astype(int)]
        m = max_len

    dp = np.full((n + 1, m + 1), np.inf, dtype=np.float32)
    dp[0, 0] = 0.0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = float(np.linalg.norm(a[i - 1] - b[j - 1]))
            dp[i, j] = cost + min(dp[i - 1, j], dp[i, j - 1], dp[i - 1, j - 1])
    return float(dp[n, m] / (n + m))


def _motion_consistency(generated_tracks: list[dict], source_tracks: dict | None, track_index: int) -> float | None:
    """소스 안무 대비 관절 궤적 정합도. 소스가 없으면 None(계약상 허용)."""
    if not source_tracks:
        return None
    src = next((t for t in source_tracks.get("tracks", []) if t.get("trackIndex") == track_index), None)
    gen = next((t for t in generated_tracks if t.get("trackIndex") == track_index), None)
    if not src or not gen:
        return None

    def centers(frames: list[dict]) -> np.ndarray:
        pts = [
            [f["bbox"]["x"] + f["bbox"]["w"] / 2, f["bbox"]["y"] + f["bbox"]["h"] / 2]
            for f in frames if f.get("bbox")
        ]
        arr = np.array(pts, dtype=np.float32)
        if arr.size == 0:
            return arr
        # 좌표계 차이를 없애기 위해 정규화
        arr -= arr.mean(axis=0)
        scale = float(np.abs(arr).max()) or 1.0
        return arr / scale

    a, b = centers(gen.get("frames", [])), centers(src.get("frames", []))
    if a.size == 0 or b.size == 0:
        return None
    d = _dtw_distance(a, b)
    return float(max(0.0, min(1.0, 1.0 / (1.0 + d * 5.0))))


def score(video_key: str, references: list[dict], source_tracks_key: str | None, sample_fps: float = 5) -> dict:
    """
    생성 결과를 독립적으로 다시 트래킹하고(§9.2), track 단위로 identity를 할당한 뒤
    인물별 5개 지표와 프레임 시계열을 산출한다.
    """
    if models.is_mock():
        return _mock_score(video_key, references, sample_fps)

    analysis = analyze_video(video_key, sample_fps=sample_fps)
    tracks = analysis["tracks"]
    source_tracks = storage.get_json(source_tracks_key) if source_tracks_key else None

    ref_ids = [r["identityId"] for r in references]
    ref_vecs = {r["identityId"]: np.array(r["faceCentroid"], dtype=np.float32) for r in references}

    # track → identity 할당 (생성 결과는 소스와 프레임 대응이 보장되지 않으므로 독립 할당)
    from .assign import assign as assign_tracks

    assignment = assign_tracks(tracks, references)
    track_to_identity = {
        a["trackIndex"]: a["identityId"] for a in assignment["assignments"] if a["identityId"]
    }

    per_identity = []
    total_span = max(1, analysis["durationMs"])

    for identity_id in ref_ids:
        my_tracks = [t for t in tracks if track_to_identity.get(t["trackIndex"]) == identity_id]
        series: list[dict] = []
        sims: list[float] = []
        deltas: list[float] = []
        valid = 0
        total = 0
        prev_vec: np.ndarray | None = None
        assigned_ms = 0

        for t in my_tracks:
            assigned_ms += max(0, t["endMs"] - t["startMs"])
            for f in t["frames"]:
                total += 1
                fv = f.get("faceVector")
                quality = float(f.get("faceQuality") or 0.0)
                occlusion = float(f.get("occlusion") or 0.0)
                if not fv:
                    series.append({
                        "ms": int(f["ms"]), "similarity": 0.0, "runnerUpSimilarity": None,
                        "runnerUpIdentityId": None, "nearestIdentityId": None,
                        "trackIndex": t["trackIndex"], "frameQuality": quality,
                        "occlusion": occlusion, "embeddingDelta": None,
                    })
                    continue

                vec = np.array(fv, dtype=np.float32)
                scored = sorted(
                    ((rid, cosine(vec, rv)) for rid, rv in ref_vecs.items()),
                    key=lambda x: -x[1],
                )
                nearest_id, _nearest_sim = scored[0]
                runner_id, runner_sim = (scored[1] if len(scored) > 1 else (None, None))
                my_sim = next((s for rid, s in scored if rid == identity_id), 0.0)

                delta = None
                if prev_vec is not None:
                    delta = float(1.0 - cosine(vec, prev_vec))
                    deltas.append(delta)
                prev_vec = vec

                sims.append(my_sim)
                valid += 1
                series.append({
                    "ms": int(f["ms"]), "similarity": my_sim,
                    "runnerUpSimilarity": runner_sim, "runnerUpIdentityId": runner_id,
                    "nearestIdentityId": nearest_id, "trackIndex": t["trackIndex"],
                    "frameQuality": quality, "occlusion": occlusion, "embeddingDelta": delta,
                })

        series.sort(key=lambda p: p["ms"])
        # 품질을 가중치로 쓴 평균 — 흐릿하거나 측면인 프레임의 영향을 줄인다(§9.2)
        if sims:
            weights = np.array([max(p["frameQuality"], 0.05) for p in series if p["similarity"] > 0], dtype=np.float32)
            vals = np.array([p["similarity"] for p in series if p["similarity"] > 0], dtype=np.float32)
            face_sim = float((vals * weights).sum() / (weights.sum() or 1.0))
        else:
            face_sim = 0.0

        track_index = my_tracks[0]["trackIndex"] if my_tracks else -1
        per_identity.append({
            "identityId": identity_id,
            "faceSimilarity": face_sim,
            # 신체 임베딩 폴백이 없는 구간에서는 얼굴 지표로 보수적으로 대체한다
            "bodySimilarity": face_sim,
            "temporalConsistency": _temporal_consistency(deltas),
            "motionConsistency": _motion_consistency(tracks, source_tracks, track_index),
            "bindingStability": float(min(1.0, assigned_ms / total_span)),
            "validFrameRatio": float(valid / total) if total else 0.0,
            "series": series,
            "trackSpans": [
                {"trackIndex": t["trackIndex"], "startMs": t["startMs"], "endMs": t["endMs"], "assigned": True}
                for t in my_tracks
            ],
        })

    return {
        "videoKey": video_key,
        "durationMs": analysis["durationMs"],
        "perIdentity": per_identity,
        "modelBundle": models.bundle(),
    }


def _mock_score(video_key: str, references: list[dict], sample_fps: float) -> dict:
    duration = 10000
    step = int(1000 / max(sample_fps, 0.1))
    per_identity = []
    for idx, r in enumerate(references):
        rid = r["identityId"]
        base = seeded_float(f"{video_key}:{rid}:base", 0.82, 0.96)
        series = []
        for ms in range(0, duration, step):
            jitter = (seeded_float(f"{video_key}:{rid}:{ms}", -0.03, 0.03))
            series.append({
                "ms": ms, "similarity": max(0.0, min(1.0, base + jitter)),
                "runnerUpSimilarity": max(0.0, base - 0.25),
                "runnerUpIdentityId": references[(idx + 1) % len(references)]["identityId"],
                "nearestIdentityId": rid, "trackIndex": idx,
                "frameQuality": 0.8, "occlusion": 0.0, "embeddingDelta": 0.01,
            })
        per_identity.append({
            "identityId": rid, "faceSimilarity": base, "bodySimilarity": base - 0.03,
            "temporalConsistency": 0.93, "motionConsistency": 0.88, "bindingStability": 0.97,
            "validFrameRatio": 1.0, "series": series,
            "trackSpans": [{"trackIndex": idx, "startMs": 0, "endMs": duration, "assigned": True}],
        })
    return {
        "videoKey": video_key, "durationMs": duration,
        "perIdentity": per_identity, "modelBundle": models.bundle(),
    }
