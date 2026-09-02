"""
Identity 할당 — §7 /v1/identity/assign, §9.1 3–4단계.

track centroid와 캐스트 profile centroid 간 코사인 유사도 행렬을 만들고
Hungarian 알고리즘으로 전역 최적 1:1 할당을 구한다.
확정 여부(τ_assign, δ_margin) 판정은 하지 않는다 — 그것은 api·워커의 몫이다(§2.2).
"""
from __future__ import annotations

import numpy as np
from scipy.optimize import linear_sum_assignment

from . import models
from .imaging import cosine


def assign(tracks: list[dict], references: list[dict]) -> dict:
    ref_ids = [r["identityId"] for r in references]
    ref_mat = np.array([r["faceCentroid"] for r in references], dtype=np.float32)

    usable = [t for t in tracks if t.get("faceCentroid")]
    if not usable:
        return {
            "assignments": [
                {"trackIndex": t["trackIndex"], "identityId": None, "similarity": 0.0,
                 "runnerUpIdentityId": None, "runnerUpSimilarity": None, "margin": None}
                for t in tracks
            ],
            "similaritySeries": {},
            "costMatrix": [],
            "modelBundle": models.bundle(),
        }

    track_mat = np.array([t["faceCentroid"] for t in usable], dtype=np.float32)

    def unit(m: np.ndarray) -> np.ndarray:
        n = np.linalg.norm(m, axis=1, keepdims=True)
        n[n == 0] = 1.0
        return m / n

    sim = unit(track_mat) @ unit(ref_mat).T   # (tracks, refs)
    cost = 1.0 - sim
    rows, cols = linear_sum_assignment(cost)
    chosen = {int(r): int(c) for r, c in zip(rows, cols)}

    assignments = []
    for i, t in enumerate(usable):
        order = np.argsort(-sim[i])
        best_j = chosen.get(i, int(order[0]))
        best = float(sim[i, best_j])
        # 2순위는 할당된 것을 제외한 최고 유사도 — δ_margin 판정 근거
        runner_j = next((int(j) for j in order if int(j) != best_j), None)
        runner = float(sim[i, runner_j]) if runner_j is not None else None
        assignments.append({
            "trackIndex": t["trackIndex"],
            "identityId": ref_ids[best_j],
            "similarity": best,
            "runnerUpIdentityId": ref_ids[runner_j] if runner_j is not None else None,
            "runnerUpSimilarity": runner,
            "margin": (best - runner) if runner is not None else None,
        })

    # centroid가 없어 할당 대상이 아닌 트랙도 결과에 남긴다(운영자 확인 대상이 된다)
    for t in tracks:
        if not t.get("faceCentroid"):
            assignments.append({
                "trackIndex": t["trackIndex"], "identityId": None, "similarity": 0.0,
                "runnerUpIdentityId": None, "runnerUpSimilarity": None, "margin": None,
            })

    # 프레임별 유사도 시계열
    series: dict[str, list[dict]] = {rid: [] for rid in ref_ids}
    for i, t in enumerate(usable):
        assigned_id = assignments[i]["identityId"]
        if assigned_id is None:
            continue
        ref_vec = ref_mat[ref_ids.index(assigned_id)]
        for f in t.get("frames") or []:
            fv = f.get("faceVector")
            if not fv:
                continue
            series[assigned_id].append({
                "ms": int(f["ms"]),
                "similarity": cosine(np.array(fv, dtype=np.float32), ref_vec),
                "trackIndex": t["trackIndex"],
            })

    return {
        "assignments": sorted(assignments, key=lambda a: a["trackIndex"]),
        "similaritySeries": series,
        "costMatrix": cost.astype(float).tolist(),
        "modelBundle": models.bundle(),
    }
