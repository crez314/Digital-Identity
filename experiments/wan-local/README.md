# WAN 2.1 VACE 로컬 자체 호스팅 타당성 실험

**질문**: 폐쇄형 API(Higgsfield) 대신 오픈웨이트 모델을 직접 돌려서, 생성 과정에 개입하고
신원(얼굴·신체) 유지를 우리가 통제할 수 있는가. 그리고 이 맥에서 그게 되는가.

**결론(2026-09-17)**: 파이프라인은 돌아간다. 하지만 **이 맥에서는 속도도 신원 유지도 실사용 수준이 아니다.**
480×640 2초 클립 1건에 24분 30초가 걸리고(실시간의 713배), 그렇게 나온 결과물도
CREZ QC 기준으로는 같은 인물로 인정되지 않는다(얼굴 유사도 0). 아래 실측 근거.

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

| 해상도 / 길이 | 가중치 | 샘플러 | 스텝 | 소요 | 스텝당 | 실시간 대비 | 피크 스왑 |
|---|---|---|---|---|---|---|---|
| 480×640 / 33f (2.06초) | GGUF Q5 | uni_pc | 20 | 18분 28초 | 45~67초 | 538배 | 21.4GB |
| 480×640 / 33f | fp16 | uni_pc | 8 | 11분 54초 | 73초 | 347배 | 24.8GB |
| 480×640 / 33f | fp16 | uni_pc | 20 | 23분 46초 | 64초 | 691배 | 21.8GB |
| 320×448 / 17f (1.06초) | fp16 | uni_pc | 20 | 5분 09초 | — | 290배 | 20.8GB |
| 320×448 / 17f | fp16 | **euler** | 20 | 5분 15초 | — | 297배 | 21.0GB |
| 480×640 / 33f | fp16 | **euler** | 20 | **24분 30초** | 67초 | 713배 | 20.9GB |

### 함정 둘 — uni_pc 샘플러가 결과를 망가뜨린다

`uni_pc` + `simple` 조합은 스텝을 늘릴수록 색이 번지며 형체가 무너진다(20스텝 결과물이 8스텝보다 나쁘다).
`euler` + `simple`로 바꾸면 같은 시간에 멀쩡한 영상이 나온다. `--bf16-unet`으로 정밀도를 바꿔도
uni_pc에서는 그대로 깨지므로 정밀도 문제가 아니라 샘플러 문제다.

### 함정 하나 — GGUF 빌드는 VACE가 꺼진다

`samuelchristlie/Wan2.1-VACE-1.3B-GGUF`를 ComfyUI-GGUF로 읽으면 로그에
`unet unexpected: ['vace_blocks.0...', ...]`가 뜨면서 **VACE 블록 전체가 실리지 않는다.**
레퍼런스 이미지 조건화가 통째로 빠진 채 일반 T2V로 도는 것이라, 용량은 작아도 쓸 수 없다.
공식 repackaged fp16 가중치를 쓰면 `Requested to load WAN21_Vace`로 정상 로드된다.

### 품질과 신원 유지

- 8스텝은 노이즈가 덜 걷혀 얼굴이 형성되지 않는다. 실사용 하한은 20스텝이고,
  그 지점에서 480×640 2초 클립에 **24분 30초**가 든다.
- euler 20스텝 결과물은 구도·동작이 자연스럽고, 레퍼런스의 속성(안경, 로고 있는 검정 티셔츠,
  청바지, 사무실 배경)을 확실히 옮겨 온다. VACE 조건화 자체는 작동한다.
- 그러나 **같은 사람은 아니다.** 그 결과물을 CREZ QC(같은 얼굴 임베딩·같은 τ_assign 0.35)로
  채점하면 어떤 track도 임계값을 넘지 못해 `얼굴 유사도 0 / binding 0`이 나온다.
  얼굴은 4개 track에서 11프레임 검출됐으니 검출 실패가 아니라 **닮지 않았다**는 뜻이다.
  480×640 전신 구도에서는 얼굴이 30px 수준이라 모델이 재현하기에도, QC가 검증하기에도 너무 작다.

즉 이 구성(1.3B, 480p, 전신)으로는 신원 유지가 안 된다. 얼굴을 키우려면 해상도를 올리거나
상반신 구도로 가야 하는데, 720p는 이 기계의 메모리로 감당이 안 되고 시간은 더 늘어난다.
14B VACE(34.7GB)는 애초에 올릴 수 없다.

## 비용 비교

| 선택지 | 5초 1건 비용 | 소요 시간 | 비고 |
|---|---|---|---|
| 이 맥 (M2 Pro 16GB) | 전기료만 | **1시간 내외**(480p 20스텝, 2초에 24분 30초 실측 기준) | 실험용으로만 가능 |
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

## 결과물을 CREZ QC로 채점하기

로컬 결과물을 상용 API 결과물과 같은 잣대로 비교하려면 `score-local.ts`를 쓴다.
MinIO에 올린 뒤 crez-ml의 `/v1/qc/score`로 채점한다(도커 스택이 떠 있어야 한다).

```bash
pnpm --filter @crez/worker exec tsx ../../experiments/wan-local/score-local.ts \
  experiments/wan-local/runtime/ComfyUI/output/wan_vace_00006_.webm <profileId>
```

crez-ml의 영상 디코딩은 h264를 전제로 하므로, webm은 먼저 mp4로 변환하는 편이 안전하다.

## GPU 대여 실측 (2026-09-18)

L40S 48GB와 H100 80GB를 빌려 14B fp16으로 돌렸다. 맥에서 0점이던 신원 유사도가 0.44~0.57로 올라왔다 —
맥의 실패는 모델 실력이 아니라 480p·1.3B 제약이었다는 뜻이다.

| 실행 | GPU | 해상도 | 스텝 | 샘플러 | cfg/shift | 얼굴 px | 얼굴 유사도 | 시간 일관성 | binding | 소요 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | L40S | 720×960 | 20 | euler | 6/8 | 84 | 0.504 | 0.217 | 1.00 | 22분 |
| 2 (kpop 프롬프트) | L40S | 720×960 | 20 | euler | 6/8 | — | 0.505 | 0.197 | 0.70 | 22분 |
| 3 | L40S | 720×960 | 20 | euler | 6/8 | — | 0.460 | 0.186 | 1.00 | 22분 |
| 4 | H100 | 720×960 | 30 | euler | 5/5 | 87 | 0.443 | 0.315 | 0.96 | 16분 |
| 5 | H100 | 720×960 | 30 | **uni_pc** | 5/5 | — | **0.298** | 0.273 | 0.96 | 14분 |
| 6 | H100 | **720×1280** | 30 | euler | 5/5 | **113** | **0.556** | 0.289 | 1.00 | 24분 |
| 7 | H100 | 720×1280 + 상반신 크롭 | 30 | euler | 5/5 | **188** | 0.565 | 0.315 | 1.00 | 24분 |
| 참고: Higgsfield kling 2.5 | — | 1244×1660 | — | — | — | 140 | **0.711** | **0.511** | 0.91 | 5분 |

### 무엇이 점수를 움직였나

- **해상도가 가장 크다.** 같은 seed·설정에서 720×960 → 720×1280으로 올리자 얼굴 유사도가 0.443 → 0.556.
  얼굴 픽셀 높이가 87px → 113px로 커진 것이 원인이다.
- **다만 얼굴을 더 키워도 한계가 있다.** 상반신 크롭으로 188px까지 키웠지만 0.565에 그쳤다.
  kling은 140px에서 0.711이므로, 남은 차이는 해상도가 아니라 **모델의 얼굴 재현력** 차이다.
- **스텝을 20 → 30으로 늘려도 얼굴 유사도는 오르지 않았다**(0.504 → 0.443). 시간 일관성만 0.217 → 0.315로 개선됐다.
- **uni_pc는 CUDA에서도 나쁘다**(0.298). 맥에서만의 문제가 아니었다 — euler를 쓴다.
- **시간 일관성은 WAN이 구조적으로 낮다**(0.19~0.32 vs kling 0.511). 프레임 간 흔들림이 크다는 뜻이고,
  눈으로 볼 때 "퀄리티가 낮다"고 느끼는 주된 원인으로 보인다.

### 비용

| | L40S | H100 |
| --- | --- | --- |
| 시간당 | $0.79 | $2.69 |
| 720×960 30스텝 | 22분 → $0.29 | 16분 → $0.72 |
| 720×1280 30스텝 | — | 24분 → $1.08 |

L40S는 EU-NL-1에만 있고 재고가 자주 빠진다(세션 중 실제로 소진돼 H100으로 옮겼다).

## GPU 대여로 옮기기

> 실제 대여 절차(계정·볼륨·포트·비용 관리·함정)는 **`RENTAL.md`** 에 따로 정리했다.

이 맥의 한계(속도·메모리·480p 얼굴 크기)는 GPU를 빌리면 전부 풀린다. 초 단위 과금이라
쓴 만큼만 낸다. `runpod-setup.sh`가 같은 워크플로를 대여 인스턴스에 그대로 올린다.

```bash
# 인스턴스에서 (네트워크 볼륨이 /workspace에 붙어 있어야 가중치가 보존된다)
bash runpod-setup.sh 14b

# 맥에서 쏜다
python run.py --server http://<pod주소>:8188 \
  --weights wan2.1_vace_14B_fp16.safetensors \
  --width 720 --height 960 --length 81 --steps 20
```

GPU별 적정 모델 (2026-09-17 RunPod 공시가)

| GPU | 시간당 (커뮤니티~시큐어) | 올릴 수 있는 모델 |
|---|---|---|
| RTX 4090 24GB | $0.34 ~ $0.74 | 1.3B 여유, 14B는 양자화 필요 |
| RTX 5090 32GB | $0.69 ~ $0.99 | 14B 양자화 |
| L40S 48GB | $0.79 ~ $1.09 | **14B fp16** |
| A100 80GB | $1.19 ~ $1.59 | 14B fp16 + 긴 클립 |

스토리지는 별도다 — 네트워크 볼륨 GB당 월 $0.07(1TB 미만). 14B fp16 34.7GB + 텍스트 인코더 +
VAE면 50GB 남짓이라 **월 $3.5 수준**이고, Pod을 꺼도 계속 나간다. Pod 볼륨(디스크)은
유휴 시 GB당 월 $0.20로 더 비싸니 가중치는 반드시 네트워크 볼륨에 둔다.

## 남은 질문

- **진짜 "생성 중 개입"**(디노이징 스텝마다 얼굴 유사도를 재서 가이던스 조절)은 ComfyUI 기성
  워크플로로는 안 된다. 추론 루프에 훅을 거는 커스텀 노드가 필요하다 — 별도 과제.
- 렌탈로 갈 경우 모델 가중치 저장(네트워크 볼륨)과 콜드스타트 시간을 비용에 포함해야 한다.
- Higgsfield API 크레딧 단가를 확인해야 손익분기를 정확히 계산할 수 있다.
