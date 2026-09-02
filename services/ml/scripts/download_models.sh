#!/usr/bin/env bash
# §7.1 퍼미시브 라이선스 모델만 내려받는다.
#   YuNet  — MIT        (opencv_zoo/models/face_detection_yunet)
#   SFace  — Apache 2.0 (opencv_zoo/models/face_recognition_sface)
# InsightFace 가중치·Ultralytics YOLO·OpenPose는 반입 금지다(§7.1 사용 금지 목록).
#
# opencv_zoo는 가중치를 Git LFS로 배포하므로 raw.githubusercontent.com은 포인터 파일만
# 돌려준다. 실제 바이너리는 media.githubusercontent.com/media 경로에서 받아야 한다.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/models"
mkdir -p "$DIR"

LFS="https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models"
MIN_BYTES=100000   # LFS 포인터(약 130B)를 실제 가중치로 착각하지 않기 위한 하한

fetch() {
  local url="$1" out="$2" path="$DIR/$2"

  if [ -f "$path" ] && [ "$(wc -c < "$path")" -ge "$MIN_BYTES" ]; then
    echo "already present: $out ($(wc -c < "$path") bytes)"
    return
  fi

  echo "downloading $out"
  curl -fsSL "$url" -o "$path"

  local size
  size="$(wc -c < "$path")"
  if [ "$size" -lt "$MIN_BYTES" ]; then
    echo "ERROR: $out is only ${size} bytes — LFS 포인터일 가능성이 높습니다." >&2
    head -c 200 "$path" >&2; echo >&2
    rm -f "$path"
    exit 1
  fi
  echo "  ok: ${size} bytes"
}

fetch "$LFS/face_detection_yunet/face_detection_yunet_2023mar.onnx" "face_detection_yunet_2023mar.onnx"
fetch "$LFS/face_recognition_sface/face_recognition_sface_2021dec.onnx" "face_recognition_sface_2021dec.onnx"

echo
echo "models in $DIR:"
ls -la "$DIR"
echo
echo "라이선스 대장(docs/licenses.md)에 확인일자를 갱신하세요."
