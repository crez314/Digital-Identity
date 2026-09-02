"""
특허 도면 생성 — 흑백 선화.

특허 도면은 원칙적으로 흑백이며 선과 해칭으로 구분한다. 컬러 그래프를 그대로
제출하면 보정 대상이 될 수 있어, 실측 데이터를 흑백으로 다시 그린다.
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/patent/figures")
OUT.mkdir(parents=True, exist_ok=True)

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "axes.linewidth": 1.0,
    "axes.edgecolor": "black",
    "figure.facecolor": "white",
})


def fig5_similarity_timeseries():
    """도5 — 프레임별 신원 유사도 시계열 및 드리프트 구간."""
    rows = list(csv.DictReader(open("outputs/frame_metrics.csv", encoding="utf-8")))
    t = [float(r["timestamp_sec"]) for r in rows]
    face = [float(r["face_similarity"]) for r in rows]
    body = [float(r["body_similarity"]) if r["body_similarity"] else None for r in rows]

    fig, ax = plt.subplots(figsize=(7.0, 3.6))
    ax.plot(t, face, color="black", lw=1.6, label="Face similarity (S_f)")
    if any(b is not None for b in body):
        ax.plot(t, body, color="black", lw=1.2, ls=(0, (5, 3)), label="Body similarity (S_b)")

    # 임계값 선 — 동일인 분포 하위 꼬리에서 정한 값
    ax.axhline(0.64, color="black", lw=0.9, ls=(0, (1, 2)))
    ax.text(t[-1], 0.655, "threshold  0.64", ha="right", va="bottom", fontsize=7)

    ax.set_xlabel("Time (sec)", fontsize=8)
    ax.set_ylabel("Cosine similarity", fontsize=8)
    ax.set_ylim(0, 1.0)
    ax.tick_params(labelsize=7)
    ax.legend(loc="lower left", fontsize=7, frameon=True, edgecolor="black")
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    fig.tight_layout()
    fig.savefig(OUT / "FIG5_similarity_timeseries.png", dpi=300, facecolor="white")
    plt.close(fig)
    print("FIG5 생성")


def fig6_discrimination():
    """도6 — 동일인/타인 유사도 분포의 분리."""
    r = json.load(open("outputs/discrimination_report.json", encoding="utf-8"))
    same, diff = r["same_person"], r["different_person"]

    fig, ax = plt.subplots(figsize=(7.0, 3.2))
    # 분포를 구간 막대로 표현 (해칭으로 구분)
    ax.barh(1, same["max"] - same["min"], left=same["min"], height=0.34,
            facecolor="white", edgecolor="black", hatch="////", lw=1.2)
    ax.barh(0, diff["max"] - diff["min"], left=diff["min"], height=0.34,
            facecolor="white", edgecolor="black", hatch="....", lw=1.2)
    # 평균 표시
    ax.plot([same["mean"]], [1], marker="|", ms=16, color="black", mew=2)
    ax.plot([diff["mean"]], [0], marker="|", ms=16, color="black", mew=2)

    ax.annotate("", xy=(same["min"], 0.5), xytext=(diff["max"], 0.5),
                arrowprops=dict(arrowstyle="<->", lw=1.0, color="black"))
    ax.text((same["min"] + diff["max"]) / 2, 0.58,
            f"separation {same['min'] - diff['max']:.3f}",
            ha="center", fontsize=7)

    ax.set_yticks([0, 1])
    ax.set_yticklabels(["Different person", "Same person"], fontsize=8)
    ax.set_xlabel("Cosine similarity", fontsize=8)
    ax.set_xlim(0, 1.0)
    ax.tick_params(labelsize=7)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    fig.tight_layout()
    fig.savefig(OUT / "FIG6_discrimination.png", dpi=300, facecolor="white")
    plt.close(fig)
    print("FIG6 생성")


if __name__ == "__main__":
    fig5_similarity_timeseries()
    fig6_discrimination()
