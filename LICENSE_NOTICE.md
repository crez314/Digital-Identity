# LICENSE NOTICE

CREZ Identity Consistency Engine이 사용하는 외부 구성요소와 그 라이선스를 기록한다.
**코드 라이선스와 사전학습 가중치 라이선스를 분리해서 판단한다** — 둘은 다르고,
실무에서 문제가 되는 쪽은 대부분 가중치다.

최종 확인일: 2026-09-02

---

## 1. production 트랙 — 상업 이용 가능

빌드에 포함되며 기본으로 선택되는 구성요소다.

| 구성요소 | 용도 | 코드 라이선스 | 가중치 라이선스 | 출처 | 수정 |
| --- | --- | --- | --- | --- | --- |
| YuNet | 얼굴 검출 | MIT | MIT | [opencv_zoo/face_detection_yunet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | 없음 |
| SFace | 얼굴 임베딩 | Apache-2.0 | Apache-2.0 | [opencv_zoo/face_recognition_sface](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) | 없음 |
| CREZ Appearance Encoder | 신체 임베딩 | — (자체 구현) | 가중치 없음 | `services/ml/app/encoders/body_appearance.py` | 자체 개발 |
| ByteTrack 방식 트래커 | 다중 인물 추적 | MIT (알고리즘) | 가중치 없음 | 알고리즘 참조: [ByteTrack](https://github.com/ifzhang/ByteTrack) | 자체 구현 |
| OpenCV | 영상·이미지 처리 | Apache-2.0 | — | opencv-python-headless | 없음 |
| NumPy / SciPy | 수치 연산 | BSD-3 | — | — | 없음 |
| matplotlib | 결과 도면 | PSF 기반 (BSD 호환) | — | — | 없음 |
| FFmpeg | 영상 인코딩 | LGPL 빌드 | — | GPL 코덱 미링크 | 없음 |

가중치는 저장소에 포함하지 않는다. `services/ml/scripts/download_models.sh`가
공식 배포처에서 내려받으며, 스크립트는 Git LFS 포인터를 실제 가중치로 오인하지
않도록 크기를 검증한다.

---

## 2. research 트랙 — 상업 이용 불가 (격리)

성능 비교 실험 전용이다. **production 빌드·기본 의존성에 포함하지 않는다.**

| 구성요소 | 코드 라이선스 | 가중치 학습 데이터 | 가중치 상업 이용 |
| --- | --- | --- | --- |
| AdaFace | MIT | MS1MV2 · MS1MV3 · WebFace4M/12M · CASIA-WebFace · VGGFace2 | **불가** |
| OSNet (torchreid) | MIT | Market-1501 · MSMT17 · DukeMTMC | **불가** |
| FastReID | Apache-2.0 | 위와 동일 계열 | **불가** |

### 근거

| 데이터셋 | 조건 |
| --- | --- |
| WebFace260M (4M/12M) | "can only be used for academic research … not allowed to use this dataset and its subsets for any commercial purposes". 서명 협약 필요 |
| MS-Celeb-1M (MS1MV2/V3 원본) | Microsoft Research License — "non-commercial academic research" 한정. **2019년 Microsoft가 프로젝트 종료·사이트 폐쇄** |
| CASIA-WebFace | "non-commercial research and educational purposes" 한정 |
| VGGFace2 | **철회됨** |
| DukeMTMC | **철회됨** |
| Market-1501 / MSMT17 | 연구 목적 한정 |

즉 **AdaFace·OSNet의 공개 배포 가중치 중 상업적으로 사용할 수 있는 것은 없다.**
코드가 MIT라는 사실이 가중치 사용 허가를 주지 않는다.

### 격리 방식

1. 코드는 `services/ml/app/encoders/research/`에만 존재한다
2. 의존성은 `requirements-research.txt`로 분리한다 (기본 설치 대상 아님)
3. `CREZ_ALLOW_RESEARCH_ENCODERS=1` 없이는 로드되지 않는다
4. `scripts/license-scan.mjs`가 CI에서 두 가지를 강제한다
   - 격리 구역 밖에서 참조되면 빌드 실패
   - production `requirements.txt`에 유입되면 빌드 실패
5. 산출물의 `provenance.encoders`에 트랙이 기록된다

두 차단 경로는 실제로 위반을 주입해 동작을 확인했다.

---

## 3. 생성 API

| 제공자 | 접근 | 계약 출처 |
| --- | --- | --- |
| Higgsfield | REST `https://api.higgsfield.ai` | 공식 OpenAPI v2.0.0 |

생성 결과물의 권리·상업 이용 범위는 소프트웨어 라이선스와 별개다. 실존 인물의
레퍼런스 업로드 허용 여부를 포함해 이용약관을 계약 시 문서로 확보해야 한다.

---

## 4. 남은 법적 검토 (라이선스와 별개)

- 실존 인물의 얼굴·신체 데이터는 개인정보보호법상 **생체인식정보**에 해당할
  가능성이 높다. 별도 동의, 처리 목적 명시, 보관 기간 제한, 파기 절차가 필요하다.
- 현재 얼굴 임베딩은 평문 저장 중이다. 암호화와 파기 절차가 미구현이다.
- AI 생성 콘텐츠 표시 의무 규제가 각국에서 정비 중이므로 배포 지역별 확인이 필요하다.
