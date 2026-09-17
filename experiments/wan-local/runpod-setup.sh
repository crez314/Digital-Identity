#!/usr/bin/env bash
# GPU 대여 인스턴스(RunPod 등)에 WAN VACE 생성 환경을 올린다.
#
# 맥에서 검증한 것과 같은 워크플로를 그대로 쓰되, 모델 크기만 GPU에 맞춰 고른다.
# /workspace가 네트워크 볼륨이면 가중치가 Pod을 껐다 켜도 남는다 — 매번 다시 받지 않으려면 반드시 여기에 둔다.
#
#   bash runpod-setup.sh 1.3b    # 검증용. 24GB급(4090)에서 충분
#   bash runpod-setup.sh 14b     # 실사용 후보. fp16은 48GB 이상(L40S/A100) 필요
#
# 끝나면 ComfyUI가 8188에서 뜬다. 맥에서 다음처럼 쏘면 된다:
#   python run.py --server http://<pod주소>:8188 --model fp16 --width 720 --height 960 --length 81 --steps 20
set -euo pipefail

SIZE="${1:-1.3b}"
ROOT="${WAN_ROOT:-/workspace}"
COMFY="$ROOT/ComfyUI"
HF="https://huggingface.co"

echo "== 설치 위치: $ROOT (네트워크 볼륨이어야 가중치가 보존된다)"
mkdir -p "$ROOT"

if [ ! -d "$COMFY" ]; then
  git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "$COMFY"
fi
pip install -q -r "$COMFY/requirements.txt"
pip install -q gguf sentencepiece protobuf   # 텍스트 인코더 토크나이저에 필요. 없으면 실행 직전에 터진다

if [ ! -d "$COMFY/custom_nodes/ComfyUI-GGUF" ]; then
  git clone --depth 1 https://github.com/city96/ComfyUI-GGUF.git "$COMFY/custom_nodes/ComfyUI-GGUF"
fi

mkdir -p "$COMFY/models/diffusion_models" "$COMFY/models/clip" "$COMFY/models/vae" "$COMFY/input"

get() { # url dest
  [ -s "$2" ] && { echo "  이미 있음: $(basename "$2")"; return; }
  echo "  받는 중: $(basename "$2")"
  curl -fL --retry 3 -o "$2" "$1"
}

REPACK="$HF/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files"

case "$SIZE" in
  1.3b)
    # 맥에서 쓴 것과 같은 구성. 신원 유지는 부족하지만 파이프라인 검증에는 이걸로 충분하다.
    get "$REPACK/diffusion_models/wan2.1_vace_1.3B_fp16.safetensors" \
        "$COMFY/models/diffusion_models/wan2.1_vace_1.3B_fp16.safetensors"
    ;;
  14b)
    # 34.7GB. 얼굴을 제대로 재현하려면 이 쪽이어야 한다. 디스크와 다운로드 시간을 미리 확보할 것.
    get "$REPACK/diffusion_models/wan2.1_vace_14B_fp16.safetensors" \
        "$COMFY/models/diffusion_models/wan2.1_vace_14B_fp16.safetensors"
    ;;
  *) echo "1.3b 또는 14b만 지원한다"; exit 1;;
esac

# GPU에서는 텍스트 인코더도 원본(bf16)을 쓴다 — 양자화는 맥의 메모리 한계 때문에 썼던 우회다.
get "$REPACK/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" \
    "$COMFY/models/clip/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
get "$REPACK/vae/wan_2.1_vae.safetensors" "$COMFY/models/vae/wan_2.1_vae.safetensors"

echo "== 레퍼런스 이미지를 $COMFY/input/ref.png 로 올릴 것"
echo "== ComfyUI 기동"
cd "$COMFY"
nohup python main.py --listen 0.0.0.0 --port 8188 --disable-auto-launch > "$ROOT/comfy.log" 2>&1 &
sleep 10
curl -sf -o /dev/null http://127.0.0.1:8188/system_stats && echo "  기동 완료 (8188)" || {
  echo "  기동 실패 — $ROOT/comfy.log 확인"; exit 1;
}

cat <<'NOTE'

주의할 것
  · 샘플러는 euler + simple을 쓴다. uni_pc는 스텝을 늘릴수록 결과가 무너진다(맥 실측).
  · GGUF 양자화 VACE 빌드는 vace_blocks가 실리지 않아 레퍼런스 조건화가 꺼진다. fp16 가중치를 쓸 것.
  · Pod을 끄면 시간당 과금은 멈추지만, 네트워크 볼륨은 월 단위로 계속 과금된다(GB당 $0.07 수준).
NOTE
