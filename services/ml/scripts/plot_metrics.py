"""
frame_metrics.csv → similarity_graph.png

시간축 위에 얼굴·신체 유사도를 그리고, 드리프트 구간을 음영과 마커로 표시한다.
특허 실시예의 실험 결과 도면으로 쓰기 위해 축·범례·임계선을 명시한다.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: plot_metrics.py <frame_metrics.csv> <out.png> [label]", file=sys.stderr)
        return 2

    csv_path, out_path = Path(sys.argv[1]), Path(sys.argv[2])
    label = sys.argv[3] if len(sys.argv) > 3 else "reference"

    t, face, body, drift, sev = [], [], [], [], []
    with csv_path.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            t.append(float(row["timestamp_sec"]))
            face.append(float(row["face_similarity"]) if row["face_similarity"] else None)
            body.append(float(row["body_similarity"]) if row["body_similarity"] else None)
            drift.append(row["drift"] == "true")
            sev.append(float(row["drift_severity"]) if row["drift_severity"] else 0.0)

    if not t:
        print("빈 CSV", file=sys.stderr)
        return 1

    fig, (ax, ax2) = plt.subplots(
        2, 1, figsize=(11, 6), sharex=True,
        gridspec_kw={"height_ratios": [3, 1], "hspace": 0.12},
    )

    # 드리프트 구간 음영 — 연속 구간을 하나로 묶어 칠한다
    start = None
    for i, d in enumerate(drift):
        if d and start is None:
            start = t[i]
        elif not d and start is not None:
            ax.axvspan(start, t[i], color="#d94f45", alpha=0.12, lw=0)
            start = None
    if start is not None:
        ax.axvspan(start, t[-1], color="#d94f45", alpha=0.12, lw=0)

    ax.plot(t, face, color="#1f5f8b", lw=1.8, label="Face similarity", zorder=3)
    if any(b is not None for b in body):
        ax.plot(t, body, color="#1b6b44", lw=1.8, ls="--", label="Body similarity", zorder=3)

    # 드리프트 프레임 마커
    dt = [t[i] for i, d in enumerate(drift) if d]
    df = [face[i] for i, d in enumerate(drift) if d]
    if dt:
        ax.scatter(dt, df, s=26, color="#b3261e", zorder=4, label="Identity drift", marker="v")

    ax.set_ylabel("Cosine similarity")
    ax.set_ylim(0, 1.02)
    ax.grid(alpha=0.18, lw=0.6)
    ax.legend(loc="lower left", fontsize=9, framealpha=0.9)
    ax.set_title(f"CREZ Identity Consistency — {label}", fontsize=12, loc="left", pad=10)

    ax2.fill_between(t, sev, color="#b3261e", alpha=0.35, lw=0)
    ax2.plot(t, sev, color="#b3261e", lw=1.2)
    ax2.set_ylabel("Drift\nseverity", fontsize=9)
    ax2.set_xlabel("Video timestamp (sec)")
    ax2.set_ylim(0, 1.02)
    ax2.grid(alpha=0.18, lw=0.6)

    for a in (ax, ax2):
        for spine in ("top", "right"):
            a.spines[spine].set_visible(False)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, dpi=150, bbox_inches="tight", facecolor="white")
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
