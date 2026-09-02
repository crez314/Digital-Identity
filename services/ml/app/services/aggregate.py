"""프로파일 집계 — §7 /v1/profile/aggregate."""
from __future__ import annotations

import numpy as np


def aggregate(vectors: list[dict], outlier_sigma: float = 3.0) -> dict:
    """
    품질 가중 centroid와 산포를 계산하고 이상치를 식별한다.

    산포(variance)는 centroid와의 코사인 거리 분산이다. 이 값이 크면
    동일 인물이 아닌 자산이 섞였을 가능성이 높다(§17 CREZ-IDN-003).
    판정은 하지 않고 수치만 돌려준다 — 임계값 적용은 api·워커 몫이다(§2.2).
    """
    ids = [v["id"] for v in vectors]
    mat = np.array([v["vector"] for v in vectors], dtype=np.float32)
    qualities = np.array([(v.get("quality") or 0.5) for v in vectors], dtype=np.float32)

    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    unit = mat / norms

    weights = qualities / (qualities.sum() or 1.0)
    centroid = (unit * weights[:, None]).sum(axis=0)
    cn = float(np.linalg.norm(centroid))
    if cn > 0:
        centroid = centroid / cn

    sims = unit @ centroid
    distances = 1.0 - sims
    variance = float(distances.var())

    # MAD 기반 이상치 — 평균/표준편차보다 소수 이상치에 강건하다
    med = float(np.median(distances))
    mad = float(np.median(np.abs(distances - med))) or 1e-6
    z = 0.6745 * (distances - med) / mad
    outlier_mask = z > outlier_sigma

    # 이상치를 제외하고 centroid를 다시 계산한다
    if outlier_mask.any() and (~outlier_mask).sum() >= 2:
        kept = unit[~outlier_mask]
        kept_w = weights[~outlier_mask]
        kept_w = kept_w / (kept_w.sum() or 1.0)
        centroid = (kept * kept_w[:, None]).sum(axis=0)
        cn = float(np.linalg.norm(centroid))
        if cn > 0:
            centroid = centroid / cn
        sims = kept @ centroid
        variance = float((1.0 - sims).var())

    pairwise = unit @ unit.T
    n = len(ids)
    mean_pairwise = float((pairwise.sum() - n) / max(n * (n - 1), 1)) if n > 1 else 1.0

    return {
        "centroid": centroid.astype(float).tolist(),
        "dim": int(mat.shape[1]),
        "variance": variance,
        "meanPairwiseSimilarity": mean_pairwise,
        "outlierIds": [ids[i] for i in range(n) if bool(outlier_mask[i])],
        "usedIds": [ids[i] for i in range(n) if not bool(outlier_mask[i])],
    }
