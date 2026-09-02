"""
변별력 측정 — 동일인/타인 유사도 분포와 임계값 근거.

**왜 필요한가**
"CREZ Score 71.3"이라는 값은 그 자체로 의미를 갖지 않는다. 완전히 다른 사람을
넣었을 때 몇 점이 나오는지 모르면, 71.3이 "신원이 잘 유지됐다"인지 "얼굴이면
누구나 이 정도"인지 구분할 수 없다.

이 스크립트는 동일인 쌍과 타인 쌍의 코사인 유사도 분포를 구해
  · 두 분포가 분리되는가
  · 분리한다면 어느 값에서 분리가 가장 깨끗한가
를 산출한다. 그 값이 face_similarity_threshold의 근거가 된다.

**측정 방식**
동일인 쌍은 같은 인물의 서로 다른 이미지(정지 이미지 + 생성 영상 프레임)로,
타인 쌍은 서로 다른 인물의 이미지로 만든다. 같은 이미지끼리의 비교(항상 1.0)는
변별력을 말해주지 않으므로 제외한다.

출력: outputs/discrimination_report.json
"""
from __future__ import annotations

import json
import sys
from itertools import combinations
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.encoders.registry import face_encoder


def encode_image(enc, path: Path) -> np.ndarray | None:
    img = cv2.imread(str(path))
    if img is None:
        return None
    r = enc.encode(img)
    return r.vector if r.ok and r.vector is not None else None


def sample_video_frames(enc, video: Path, max_frames: int = 12) -> list[np.ndarray]:
    """생성 영상에서 얼굴 벡터를 뽑는다 — 같은 인물의 '다른 이미지'로 쓴다."""
    cap = cv2.VideoCapture(str(video))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if total <= 0:
        cap.release()
        return []
    idxs = np.linspace(0, total - 1, min(max_frames, total)).astype(int)
    out: list[np.ndarray] = []
    for i in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
        ok, frame = cap.read()
        if not ok:
            continue
        r = enc.encode(frame)
        if r.ok and r.vector is not None:
            out.append(r.vector)
    cap.release()
    return out


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    return float(np.dot(a, b) / (na * nb)) if na and nb else 0.0


def best_threshold(same: list[float], diff: list[float]) -> dict:
    """
    동일인/타인을 가장 깨끗하게 가르는 임계값을 찾는다.
    후보를 훑으며 정확도가 최대가 되는 지점과, 그때의 FAR/FRR을 함께 낸다.
    """
    if not same or not diff:
        return {"threshold": None, "accuracy": None, "far": None, "frr": None}

    candidates = sorted(set(np.round(np.concatenate([same, diff]), 4)))
    best = {"threshold": None, "accuracy": -1.0, "far": None, "frr": None}
    for t in candidates:
        # 임계값 이상이면 동일인이라고 판정
        tp = sum(1 for s in same if s >= t)
        fn = len(same) - tp
        fp = sum(1 for d in diff if d >= t)
        tn = len(diff) - fp
        acc = (tp + tn) / (len(same) + len(diff))
        if acc > best["accuracy"]:
            best = {
                "threshold": float(t),
                "accuracy": round(acc, 4),
                "far": round(fp / len(diff), 4),   # 타인을 동일인으로 오인
                "frr": round(fn / len(same), 4),   # 동일인을 타인으로 오인
            }
    return best


def stats(values: list[float]) -> dict:
    if not values:
        return {"count": 0}
    a = np.array(values, dtype=np.float64)
    return {
        "count": len(values),
        "mean": round(float(a.mean()), 4),
        "std": round(float(a.std()), 4),
        "min": round(float(a.min()), 4),
        "max": round(float(a.max()), 4),
        "p05": round(float(np.percentile(a, 5)), 4),
        "p95": round(float(np.percentile(a, 95)), 4),
    }


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: measure_discrimination.py <manifest.json> <out.json>", file=sys.stderr)
        print('manifest: {"identities": {"A": {"images": [...], "video": "..."}, "B": {...}}}',
              file=sys.stderr)
        return 2

    manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_path = Path(sys.argv[2])
    enc = face_encoder()

    # 인물별 벡터 수집
    vectors: dict[str, list[np.ndarray]] = {}
    sources: dict[str, list[str]] = {}
    for name, spec in manifest["identities"].items():
        vs: list[np.ndarray] = []
        src: list[str] = []
        for img in spec.get("images", []):
            v = encode_image(enc, Path(img))
            if v is not None:
                vs.append(v)
                src.append(f"image:{Path(img).name}")
        if spec.get("video"):
            frames = sample_video_frames(enc, Path(spec["video"]))
            vs.extend(frames)
            src.extend([f"video:frame{i}" for i in range(len(frames))])
        vectors[name] = vs
        sources[name] = src
        print(f"  {name}: {len(vs)}개 벡터 ({sum(1 for s in src if s.startswith('image'))} 이미지 "
              f"+ {sum(1 for s in src if s.startswith('video'))} 프레임)")

    # 동일인 쌍 — 같은 인물의 서로 다른 이미지
    same: list[float] = []
    for name, vs in vectors.items():
        for a, b in combinations(range(len(vs)), 2):
            same.append(cosine(vs[a], vs[b]))

    # 타인 쌍 — 서로 다른 인물
    diff: list[float] = []
    pair_detail: list[dict] = []
    names = list(vectors)
    for i, j in combinations(range(len(names)), 2):
        n1, n2 = names[i], names[j]
        pair_vals = [cosine(v1, v2) for v1 in vectors[n1] for v2 in vectors[n2]]
        diff.extend(pair_vals)
        pair_detail.append({"pair": f"{n1} vs {n2}", **stats(pair_vals)})

    same_s, diff_s = stats(same), stats(diff)
    thr = best_threshold(same, diff)

    # 두 분포가 겹치는가 — 겹치면 그 구간에서는 판정이 불가능하다
    overlap = None
    if same and diff:
        overlap = round(max(0.0, float(max(diff)) - float(min(same))), 4)

    report = {
        "encoder": enc.info.as_bundle(),
        "identities": {k: len(v) for k, v in vectors.items()},
        "same_person": same_s,
        "different_person": diff_s,
        "separation": {
            "margin": round(same_s.get("mean", 0) - diff_s.get("mean", 0), 4),
            "min_same_vs_max_diff": overlap,
            "overlapping": overlap is not None and overlap > 0,
        },
        "optimal_threshold": thr,
        "pairwise": pair_detail,
        "note": (
            "동일인 쌍은 같은 인물의 서로 다른 이미지·프레임으로 구성했다. "
            "동일 이미지 비교(항상 1.0)는 변별력을 말해주지 않으므로 제외했다."
        ),
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print()
    print(f"  동일인 쌍 {same_s['count']}건  평균 {same_s['mean']}  범위 {same_s['min']}~{same_s['max']}")
    print(f"  타인   쌍 {diff_s['count']}건  평균 {diff_s['mean']}  범위 {diff_s['min']}~{diff_s['max']}")
    print(f"  분리 마진 {report['separation']['margin']}")
    print(f"  최적 임계값 {thr['threshold']} (정확도 {thr['accuracy']}, FAR {thr['far']}, FRR {thr['frr']})")
    print(f"\n  → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
