"""
research 트랙 인코더 — 성능 비교 실험 전용.

여기 있는 인코더들은 코드 라이선스는 퍼미시브(MIT/Apache 2.0)이나
**배포 가중치가 연구 전용 데이터셋으로 학습**되어 상업 이용이 허용되지 않는다.

  AdaFace  가중치 학습: MS1MV2 / MS1MV3 / WebFace4M·12M / CASIA-WebFace / VGGFace2
           → MS-Celeb-1M은 2019년 철회, WebFace260M은 상업 이용 금지 명시,
             CASIA-WebFace는 비상업 연구 전용, VGGFace2는 철회
  OSNet    가중치 학습: Market-1501 / MSMT17 / DukeMTMC(철회)
  FastReID 동일

따라서 이 디렉터리의 코드는
  · production 빌드에 포함하지 않는다
  · 기본 requirements에 의존성을 넣지 않는다 (requirements-research.txt로 분리)
  · CREZ_ALLOW_RESEARCH_ENCODERS=1 없이는 로드되지 않는다
  · 산출물(리포트)에 track=research로 표시된다

용도는 하나다 — 동일한 CREZ 상위 계층이 서로 다른 인코더 계열에서도
동작함을 보이는 것(모델 비종속성 입증) 및 성능 상한 참고.
"""
