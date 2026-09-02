"""
QC 점수 산출 — §7 /v1/qc/score, §10.1 지표 정의.

**합격 여부를 판단하지 않는다.** 점수와 프레임 단위 원시 시계열만 반환하고,
임계값 적용과 finding 생성은 crez-api의 QC 규칙 엔진이 담당한다(§7, §2.2).

**두 종류의 신호를 모두 낸다**
  · reference-to-frame : 기준 인물과 이 프레임이 얼마나 닮았는가 (누구인가)
  · frame-to-frame     : 직전 프레임 대비 얼마나 변했는가 (갑자기 변했는가)
둘은 다른 현상을 잡는다. 기준과 꾸준히 다르지만 안정적인 경우와, 기준과는
맞지만 프레임마다 튀는 경우를 구분해야 재생성 전략을 고를 수 있다.

얼굴과 신체를 각각 독립적으로 산출한다. 신체를 얼굴에서 파생시키면 얼굴이
보이지 않는 프레임에서 아무 정보도 주지 못한다.
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
    """
    소스 안무 대비 궤적 정합도. 소스가 없으면 None(계약상 허용).

    현재는 bbox 중심 궤적을 비교한다. 관절 단위 정합은 포즈 추정기를 붙인 뒤
    같은 인터페이스로 교체한다 — 지금 값을 '관절 궤적 정합도'라고 부르지 않는다.
    """
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
        arr -= arr.mean(axis=0)
        scale = float(np.abs(arr).max()) or 1.0
        return arr / scale

    a, b = centers(gen.get("frames", [])), centers(src.get("frames", []))
    if a.size == 0 or b.size == 0:
        return None
    d = _dtw_distance(a, b)
    return float(max(0.0, min(1.0, 1.0 / (1.0 + d * 5.0))))


def score(
    video_key: str,
    references: list[dict],
    source_tracks_key: str | None,
    sample_fps: float = 5,
) -> dict:
    """
    생성 결과를 독립적으로 다시 트래킹하고(§9.2), track 단위로 identity를 할당한 뒤
    인물별 지표와 프레임 시계열을 산출한다.

    references[].faceCentroid는 필수, bodyCentroid는 선택이다. 신체 기준이 없으면
    신체 지표는 None으로 반환하고, 상위 계층이 가중치를 재분배한다.
    """
    if models.is_mock():
        return _mock_score(video_key, references, sample_fps)

    analysis = analyze_video(video_key, sample_fps=sample_fps, extract_body=True)
    tracks = analysis["tracks"]
    source_tracks = storage.get_json(source_tracks_key) if source_tracks_key else None

    ref_ids = [r["identityId"] for r in references]
    ref_face = {r["identityId"]: np.array(r["faceCentroid"], dtype=np.float32) for r in references}
    ref_body = {
        r["identityId"]: np.array(r["bodyCentroid"], dtype=np.float32)
        for r in references
        if r.get("bodyCentroid")
    }

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
        face_sims: list[float] = []
        body_sims: list[float] = []
        face_deltas: list[float] = []
        body_deltas: list[float] = []
        valid = 0
        total = 0
        prev_face: np.ndarray | None = None
        prev_body: np.ndarray | None = None
        assigned_ms = 0
        body_ref = ref_body.get(identity_id)

        for t in my_tracks:
            assigned_ms += max(0, t["endMs"] - t["startMs"])
            for f in t["frames"]:
                total += 1
                quality = float(f.get("faceQuality") or 0.0)
                occlusion = float(f.get("occlusion") or 0.0)

                # ── 얼굴 ──────────────────────────────────
                fv = f.get("faceVector")
                face_sim = 0.0
                nearest_id = runner_id = None
                runner_sim = None
                face_delta = None

                if fv:
                    vec = np.array(fv, dtype=np.float32)
                    scored = sorted(
                        ((rid, cosine(vec, rv)) for rid, rv in ref_face.items()),
                        key=lambda x: -x[1],
                    )
                    nearest_id, _ = scored[0]
                    runner_id, runner_sim = (scored[1] if len(scored) > 1 else (None, None))
                    face_sim = next((s for rid, s in scored if rid == identity_id), 0.0)

                    if prev_face is not None:
                        face_delta = float(1.0 - cosine(vec, prev_face))
                        face_deltas.append(face_delta)
                    prev_face = vec
                    face_sims.append(face_sim)
                    valid += 1

                # ── 신체 (얼굴과 독립) ─────────────────────
                bv = f.get("bodyVector")
                body_sim = None
                body_delta = None
                if bv and body_ref is not None:
                    bvec = np.array(bv, dtype=np.float32)
                    body_sim = cosine(bvec, body_ref)
                    body_sims.append(body_sim)
                    if prev_body is not None:
                        body_delta = float(1.0 - cosine(bvec, prev_body))
                        body_deltas.append(body_delta)
                    prev_body = bvec
                elif bv:
                    # 신체 기준이 없어도 프레임 간 변화량은 의미가 있다
                    bvec = np.array(bv, dtype=np.float32)
                    if prev_body is not None:
                        body_delta = float(1.0 - cosine(bvec, prev_body))
                        body_deltas.append(body_delta)
                    prev_body = bvec

                series.append({
                    "ms": int(f["ms"]),
                    "similarity": face_sim,
                    "runnerUpSimilarity": runner_sim,
                    "runnerUpIdentityId": runner_id,
                    "nearestIdentityId": nearest_id,
                    "trackIndex": t["trackIndex"],
                    "frameQuality": quality,
                    "occlusion": occlusion,
                    "embeddingDelta": face_delta,
                    "bodySimilarity": body_sim,
                    "bodyDelta": body_delta,
                })

        series.sort(key=lambda p: p["ms"])

        # 품질 가중 평균 — 흐리거나 측면인 프레임의 영향을 줄인다(§9.2)
        face_similarity = _weighted_mean(
            [(p["similarity"], max(p["frameQuality"], 0.05)) for p in series if p["similarity"] > 0]
        )
        body_similarity = (
            _weighted_mean(
                [(p["bodySimilarity"], max(p["frameQuality"], 0.05))
                 for p in series if p["bodySimilarity"] is not None]
            )
            if body_sims else None
        )

        track_index = my_tracks[0]["trackIndex"] if my_tracks else -1
        per_identity.append({
            "identityId": identity_id,
            "faceSimilarity": face_similarity,
            "bodySimilarity": body_similarity,
            "temporalConsistency": _temporal_consistency(face_deltas),
            "temporalBodyConsistency": _temporal_consistency(body_deltas) if body_deltas else None,
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
        "modelBundle": analysis["modelBundle"],
    }


def _weighted_mean(pairs: list[tuple[float, float]]) -> float:
    if not pairs:
        return 0.0
    vals = np.array([p[0] for p in pairs], dtype=np.float32)
    ws = np.array([p[1] for p in pairs], dtype=np.float32)
    return float((vals * ws).sum() / (ws.sum() or 1.0))


def _mock_score(video_key: str, references: list[dict], sample_fps: float) -> dict:
    duration = 10000
    step = int(1000 / max(sample_fps, 0.1))
    per_identity = []
    for idx, r in enumerate(references):
        rid = r["identityId"]
        base = seeded_float(f"{video_key}:{rid}:base", 0.82, 0.96)
        series = []
        for ms in range(0, duration, step):
            jitter = seeded_float(f"{video_key}:{rid}:{ms}", -0.03, 0.03)
            series.append({
                "ms": ms, "similarity": max(0.0, min(1.0, base + jitter)),
                "runnerUpSimilarity": max(0.0, base - 0.25),
                "runnerUpIdentityId": references[(idx + 1) % len(references)]["identityId"],
                "nearestIdentityId": rid, "trackIndex": idx,
                "frameQuality": 0.8, "occlusion": 0.0, "embeddingDelta": 0.01,
                "bodySimilarity": max(0.0, min(1.0, base - 0.05)), "bodyDelta": 0.02,
            })
        per_identity.append({
            "identityId": rid, "faceSimilarity": base, "bodySimilarity": base - 0.05,
            "temporalConsistency": 0.93, "temporalBodyConsistency": 0.91,
            "motionConsistency": 0.88, "bindingStability": 0.97,
            "validFrameRatio": 1.0, "series": series,
            "trackSpans": [{"trackIndex": idx, "startMs": 0, "endMs": duration, "assigned": True}],
        })
    return {
        "videoKey": video_key, "durationMs": duration,
        "perIdentity": per_identity, "modelBundle": models.bundle(),
    }
