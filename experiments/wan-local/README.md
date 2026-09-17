# WAN 2.1 VACE 로컬 자체 호스팅 타당성 실험

**질문**: 폐쇄형 API(Higgsfield) 대신 오픈웨이트 모델을 직접 돌려서, 생성 과정에 개입하고
신원(얼굴·신체) 유지를 우리가 통제할 수 있는가. 그리고 이 맥에서 그게 되는가.

**결론(2026-09-17)**: 기능은 된다. **이 맥에서 실사용은 안 된다.** 아래 실측 근거.

## 왜 VACE인가

계정에서 `veo3.1/reference-to-video`가 404로 막혀 있어(§Higgsfield 실측), 레퍼런스 이미지로
인물을 고정하는 경로가 상용 API에 없다. Wan2.1-VACE는 그 자리를 메우는 오픈 대안이다 —
`reference_image`를 받아 영상 내내 같은 인물을 유지하도록 조건화한다.

## 측정 환경

| 항목 | 값 |
|---|---|
| 기계 | MacBook Pro (Mac14,10), Apple M2 Pro, CPU 12코어 / GPU 19코어 |
| 통합 메모리 | 16GB |
| 가속 | PyTorch 2.14 MPS (Metal) |
| ComfyUI | 0.36.0 |
| 확산 모델 | `wan2.1_vace_1.3B_fp16.safetensors` (4.0GB, Comfy-Org repackaged) |
| 텍스트 인코더 | `umt5-xxl-encoder-Q5_K_M.gguf` (3.9GB, CPU에서 실행) |
| VAE | `wan_2.1_vae.safetensors` (242MB) |

실험 전에 도커 컨테이너 8개(CREZ 스택 + 다른 프로젝트 DB)를 내려 메모리를 비웠다.
그러고도 생성 중 스왑이 최대 24.8GB까지 올라갔다 — 16GB로는 모델을 메모리에 다 못 들고 있다는 뜻이다.

## 실측 결과

480×640, 33프레임(16fps = 2.06초) 기준:

| 가중치 | 스텝 | 소요 | 스텝당 | 실시간 대비 | 피크 스왑 |
|---|---|---|---|---|---|
| GGUF Q5_K_M (1.5GB) | 20 | **18분 28초** | 45~67초 | **538배** | 21.4GB |
| fp16 (4.0GB) | 8 | **11분 54초** | 73초 | 347배 | 24.8GB |

### 함정 하나 — GGUF 빌드는 VACE가 꺼진다

`samuelchristlie/Wan2.1-VACE-1.3B-GGUF`를 ComfyUI-GGUF로 읽으면 로그에
`unet unexpected: ['vace_blocks.0...', ...]`가 뜨면서 **VACE 블록 전체가 실리지 않는다.**
레퍼런스 이미지 조건화가 통째로 빠진 채 일반 T2V로 도는 것이라, 용량은 작아도 쓸 수 없다.
공식 repackaged fp16 가중치를 쓰면 `Requested to load WAN21_Vace`로 정상 로드된다.

### 품질

8스텝 결과물은 노이즈가 덜 걷혀 얼굴이 형성되지 않는다(WAN 1.3B는 20스텝 이상 필요).
즉 **쓸 만한 품질의 하한이 20스텝이고, 그 지점에서 2초 클립에 20분대**가 든다.

## 비용 비교

| 선택지 | 5초 1건 비용 | 소요 시간 | 비고 |
|---|---|---|---|
| 이 맥 (M2 Pro 16GB) | 전기료만 | **1시간 내외**(480p 20스텝 추정) | 실험용으로만 가능 |
| RunPod RTX 4090 24GB | $0.34~0.74/hr → 건당 $0.03~0.07 | 수 분 | 실사용 가능선 |
| RunPod RTX 5090 32GB | $0.69~0.99/hr | 수 분 | 여유 |
| Higgsfield kling 2.5 turbo pro | 1.25 크레딧 | 4~6분 | 현재 운영 방식 |

## 재현 방법

```bash
cd experiments/wan-local
python3.12 -m venv venv && venv/bin/pip install torch torchvision torchaudio sentencepiece protobuf
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git runtime/ComfyUI
venv/bin/pip install -r runtime/ComfyUI/requirements.txt
git clone --depth 1 https://github.com/city96/ComfyUI-GGUF.git runtime/ComfyUI/custom_nodes/ComfyUI-GGUF
venv/bin/pip install gguf

# 가중치 (runtime/ComfyUI/models/ 아래)
#   diffusion_models/wan2.1_vace_1.3B_fp16.safetensors  ← Comfy-Org/Wan_2.1_ComfyUI_repackaged
#   clip/umt5-xxl-encoder-Q5_K_M.gguf                   ← city96/umt5-xxl-encoder-gguf
#   vae/wan_2.1_vae.safetensors                         ← Comfy-Org/Wan_2.1_ComfyUI_repackaged

# 레퍼런스 이미지를 runtime/ComfyUI/input/ref.png 로 두고
cd runtime/ComfyUI && ../../venv/bin/python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch &
venv/bin/python run.py --model fp16 --length 33 --width 480 --height 640 --steps 20
```

`runtime/`, `venv/`, `outputs/`는 `.gitignore` 대상이다(수 GB). 저장소에는 워크플로와 측정 스크립트만 둔다.

## 남은 질문

- **진짜 "생성 중 개입"**(디노이징 스텝마다 얼굴 유사도를 재서 가이던스 조절)은 ComfyUI 기성
  워크플로로는 안 된다. 추론 루프에 훅을 거는 커스텀 노드가 필요하다 — 별도 과제.
- 렌탈로 갈 경우 모델 가중치 저장(네트워크 볼륨)과 콜드스타트 시간을 비용에 포함해야 한다.
- Higgsfield API 크레딧 단가를 확인해야 손익분기를 정확히 계산할 수 있다.
