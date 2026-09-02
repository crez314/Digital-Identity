# 라이선스 대장

기술명세서 §7.4에 따라 사용 중인 모든 모델·라이브러리의 이름, 버전, 라이선스, 출처 URL,
확인일자를 기록한다. CI의 라이선스 스캐너(`scripts/license-scan.mjs`)가 AGPL 및
비상업 라이선스 의존성이 추가되면 빌드를 실패시킨다.

**원칙** — 상업 이용이 명시적으로 허용된 퍼미시브 라이선스 모델만 채택한다.
퍼미시브 라이선스가 학습 데이터 출처 문제까지 완전히 해소하지는 않지만, 배포자가
"사용 금지"를 명시한 모델을 쓰는 것과 Apache 2.0/MIT로 명시적 이용 허락을 부여한 모델을
쓰는 것은 법적 방어 가능성이 크게 다르다.

## 1. 채택 ML 모델 (§7.1)

| 단계 | 모델 | 버전 | 라이선스 | 출처 | 확인일 |
| --- | --- | --- | --- | --- | --- |
| 얼굴 검출 | YuNet | 2023mar | MIT | https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet | 2026-09-01 |
| 얼굴 임베딩 | SFace | 2021dec | Apache 2.0 | https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface | 2026-09-01 |
| 인물 검출 | RTMDet-m | 1.0 | Apache 2.0 | https://github.com/open-mmlab/mmdetection/tree/main/configs/rtmdet | 미도입 (선택적) |
| 다중 인물 트래킹 | ByteTrack 방식 | 자체 구현 | MIT (알고리즘) | https://github.com/ifzhang/ByteTrack | 2026-09-01 |
| 포즈 추정 | RTMPose-m | 1.0 | Apache 2.0 | https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose | 미도입 (선택적) |
| 랜드마크 | YuNet 5점 랜드마크 | 2023mar | MIT | (위와 동일) | 2026-09-01 |

트래킹은 가중치 파일이 필요 없는 알고리즘 계층이므로 `services/ml/app/services/tracking.py`에
ByteTrack 방식(고신뢰 → 저신뢰 2단계 매칭)으로 직접 구현했다. 라이선스 리스크가 없다.

RTMDet/RTMPose는 ONNX 가중치가 배치되면 자동으로 사용되고, 없으면 얼굴 기반 검출과
`keypoints: null`로 동작한다(`services/ml/app/services/models.py`).

## 2. 사용 금지 목록 — 코드베이스 반입 불가 (§7.1)

| 대상 | 사유 | 대체 |
| --- | --- | --- |
| InsightFace 사전학습 가중치 (buffalo_l, antelopev2, buffalo_s/m, SCRFD·RetinaFace) | 코드는 MIT이나 학습 데이터와 그 데이터로 학습된 모델은 비상업 연구 목적 전용. GitHub 수동 다운로드와 파이썬 라이브러리 자동 다운로드에 동일 적용 | YuNet + SFace |
| Ultralytics YOLO (v5/v8/v11) | AGPL-3.0. 네트워크 서비스 제공만으로 소스 공개 의무 발동 — SaaS 구조에 치명적 | RTMDet 또는 YOLOX |
| OpenPose | 상업 이용 불가 | RTMPose |
| AdaFace / MagFace 공개 가중치 | 코드는 MIT/Apache 2.0이나 가중치가 Glint360K 등 연구용 데이터셋 학습 | SFace |
| facenet-pytorch 가중치 | VGGFace2 기반이며 해당 데이터셋 철회 | SFace |

상업 이용을 원할 경우 InsightFace는 별도 라이선스 구매가 필요하다
(`recognition-oss-pack@insightface.ai`). 구매 판단은 Phase 2 실측 결과가 KPI 목표에
미달할 경우에만 진행한다(§7.2, §22).

## 3. 영상 처리 (§7.3)

| 대상 | 구성 | 라이선스 |
| --- | --- | --- |
| FFmpeg | **LGPL 빌드**. x264·x265 등 GPL 코덱은 링크하지 않는다 | LGPL 2.1+ |
| H.264/HEVC 인코딩 | 하드웨어 인코더(NVENC/VideoToolbox) 또는 로열티가 커버되는 대안 | — |

`apps/worker/src/lib/ffmpeg.ts`의 `FFMPEG_VIDEO_ENCODER` 환경변수로 인코더를 지정한다.
코덱 특허 로열티는 소프트웨어 라이선스와 별개 사안이며, 배포 규모가 커지는 Phase 5 이전에
별도 검토한다(§22).

> 주의: Debian/Ubuntu의 기본 `ffmpeg` 패키지는 GPL 코덱을 포함할 수 있다. 운영 이미지는
> `--disable-gpl` 구성으로 빌드한 바이너리를 사용해야 한다
> (`infra/docker/worker.Dockerfile` 주석 참조).

## 4. 주요 런타임 라이브러리

| 패키지 | 라이선스 | 용도 |
| --- | --- | --- |
| NestJS 10 | MIT | API 서버 |
| Prisma 5 | Apache 2.0 | ORM |
| BullMQ 5 | MIT | 큐 |
| pgvector 0.7 | PostgreSQL License | 임베딩 저장 |
| Next.js 14 | MIT | 웹 클라이언트 |
| FastAPI | MIT | ML 서비스 |
| opencv-python-headless | Apache 2.0 | YuNet/SFace 추론 |
| numpy | BSD-3 | 수치 연산 |
| scipy | BSD-3 | Hungarian, DTW |
| onnxruntime | MIT | ONNX 추론 |
| boto3 | Apache 2.0 | S3 호환 스토리지 |

## 5. 갱신 절차

1. 새 모델·라이브러리를 도입하기 전에 이 표에 행을 추가한다.
2. `node scripts/license-scan.mjs`를 로컬에서 실행한다.
3. CI의 `licenses` job이 통과해야 머지할 수 있다.
4. 모델 가중치를 새로 내려받으면 확인일자를 갱신한다.

## 6. 남은 법적 검토 항목 (§22)

라이선스와 별개로 남는 사안이다.

- 실존 인물의 얼굴·신체 데이터는 개인정보보호법상 **생체인식정보**에 해당할 가능성이 높다.
  별도 동의, 처리 목적 명시, 보관 기간 제한, 파기 절차가 필요하다.
- AI 생성 콘텐츠 표시 의무 관련 규제가 각국에서 정비 중이므로 배포 대상 지역별 확인이 필요하다.
- 개발 착수와 병행해 법무 검토를 진행할 것.
