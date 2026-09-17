"""
로컬 WAN(VACE) 생성 1건을 ComfyUI API로 제출하고 소요 시간·피크 메모리를 잰다.

목적은 그림이 아니라 숫자다 — 이 맥(M2 Pro 16GB)에서 자체 호스팅이 실용적인지 판단할 근거.

  python run.py [--length 33] [--width 480] [--height 640] [--steps 20]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = "http://127.0.0.1:8188"


def post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{SERVER}{path}", data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{SERVER}{path}") as r:
        return json.loads(r.read())


def rss_gb(pid: int) -> float:
    """대상 프로세스의 상주 메모리(GB). macOS ps 기준."""
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                             capture_output=True, text=True).stdout.strip()
        return int(out) / 1048576 if out else 0.0
    except Exception:
        return 0.0


def swap_used_gb() -> float:
    out = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
    for tok in out.split():
        if tok.startswith("used"):
            pass
    # "total = 16384.00M  used = 14974.94M  free = 1409.06M"
    parts = out.replace("=", " ").split()
    try:
        i = parts.index("used")
        return float(parts[i + 1].rstrip("M")) / 1024
    except Exception:
        return 0.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--length", type=int, default=33, help="프레임 수 (16fps 기준, (n-1)%%4==0)")
    ap.add_argument("--width", type=int, default=480)
    ap.add_argument("--height", type=int, default=640)
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--pid", type=int, default=0, help="ComfyUI 프로세스 PID (메모리 측정용)")
    ap.add_argument("--model", choices=["gguf", "fp16"], default="fp16",
                    help="gguf는 용량이 작지만 VACE 블록이 실리지 않아 레퍼런스 조건화가 꺼진다")
    args = ap.parse_args()

    wf = json.loads((ROOT / "workflow-vace.json").read_text())
    if args.model == "fp16":
        # GGUF(samuelchristlie) 빌드는 ComfyUI가 vace_blocks를 인식하지 못해
        # 레퍼런스 이미지 조건화가 통째로 빠진다(로그의 'unet unexpected: vace_blocks.*').
        # 공식 repackaged fp16 가중치를 쓰면 정상적으로 실린다.
        wf["1"] = {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "wan2.1_vace_1.3B_fp16.safetensors", "weight_dtype": "default"},
        }
    wf["8"]["inputs"].update(width=args.width, height=args.height, length=args.length)
    wf["9"]["inputs"]["steps"] = args.steps

    seconds = args.length / 16.0
    print(f"요청: {args.width}x{args.height}, {args.length}프레임({seconds:.2f}초 @16fps), {args.steps}스텝")

    started = time.time()
    res = post("/prompt", {"prompt": wf})
    pid_ = res.get("prompt_id")
    if not pid_:
        print("제출 실패:", res)
        return 1

    peak_rss = 0.0
    peak_swap = swap_used_gb()
    last_note = ""
    while True:
        time.sleep(3)
        if args.pid:
            peak_rss = max(peak_rss, rss_gb(args.pid))
        peak_swap = max(peak_swap, swap_used_gb())
        hist = get(f"/history/{pid_}")
        if pid_ in hist:
            entry = hist[pid_]
            status = entry.get("status", {})
            elapsed = time.time() - started
            if status.get("status_str") == "error" or not status.get("completed", True):
                print(f"실패 ({elapsed:.0f}초)")
                for m in status.get("messages", [])[-6:]:
                    print("  ", json.dumps(m, ensure_ascii=False)[:400])
                return 1
            print(f"완료: {elapsed:.0f}초 "
                  f"({elapsed / seconds:.0f}배 실시간), 피크 RSS {peak_rss:.1f}GB, 피크 스왑 {peak_swap:.1f}GB")
            for out in entry.get("outputs", {}).values():
                for key in ("images", "videos", "gifs"):
                    for f in out.get(key, []) or []:
                        print("  결과물:", f.get("filename"))
            return 0
        note = f"{time.time() - started:.0f}초 경과"
        if note != last_note:
            print(" ", note, end="\r", flush=True)
            last_note = note


if __name__ == "__main__":
    sys.exit(main())
