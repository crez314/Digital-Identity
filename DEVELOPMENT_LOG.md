# DEVELOPMENT LOG

특허 출원 및 프로그램저작권 증빙을 위한 개발 이력.
**CREZ 자체 모듈**(Reference Aggregation · Temporal Consistency · Identity Drift
Detection · Score Fusion)의 변경과 수식 변화를 우선 기록한다.

---

## 2026-09-02 — Identity Consistency PoC

### 구현 기능

| 영역 | 내용 | 트랙 |
| --- | --- | --- |
| Encoder Interface | `FaceEncoder` / `BodyEncoder` 추상화, 설정 기반 선택 | 자체 |
| Reference Aggregation | MAD 이상치 제거 + 품질 가중 centroid | 자체 |
| Body Encoder | 4밴드 HSV + 그래디언트 방향 기술자 | 자체 |
| Temporal Consistency | 얼굴·신체 각각의 frame-to-frame 변화량 | 자체 |
| Drift Severity | 4신호 가중 결합, 연속값 0~1 + 사유 | 자체 |
| Score Fusion | 가중합 + 드리프트 감점 분리 | 자체 |
| Statistics | 하위 백분위·분산 | 자체 |
| Normalization | 구간 선형 → 보정 곡선 교체 가능 | 자체 |
| Face Encoder | YuNet + SFace | 오픈소스 |
| Tracking | ByteTrack 방식 2단계 매칭 | 알고리즘 참조 |

### 알고리즘 버전 및 수식

**Reference Aggregation v1.0**
```
centroid = normalize( Σ (quality_i / Σquality) · unit(v_i) )
variance = Var( 1 - cos(unit(v_i), centroid) )
이상치   = 0.6745 · (d_i - median(d)) / MAD(d) > σ    (σ 기본 3.0)
```
평균 대신 MAD를 쓴 이유 — 소수의 잘못된 자산이 섞였을 때 평균·표준편차는
그 자산에 끌려가지만 중앙값 기반 지표는 견딘다.

**Temporal Consistency v1.0**
```
D(t)     = 1 - cos(v_t, v_{t-1})
consist  = 1 / (1 + mean(D) · 10)
```
얼굴과 신체에 각각 독립 적용한다.

**Drift Severity v1.0** (신규)
```
shortfall(x, θ) = max(0, (θ - x) / θ)          기준 대비 하락
excess(d, θ)    = max(0, (d - θ) / θ)          프레임 간 변화 초과
duration        = min(1, t_run / t_sat)

severity = Σ wᵢ·signalᵢ / Σ wᵢ
  signals = [ shortfall(face_sim), shortfall(body_sim),
              excess(face_Δ), excess(body_Δ), duration ]
```
신체 신호가 없으면 해당 가중치를 얼굴로 재분배한다 — 0으로 두면 신체 미검출이
곧 심각도로 둔갑한다.

**Score Fusion v1.0** (신규)
```
repr(stats) = mean·(1-τ) + p05·τ                 τ 기본 0.30
base  = Σ wᵢ·scoreᵢ / Σ wᵢ                        (face, body, tFace, tBody)
pen   = w_drift · clamp(ratio·avgSev + maxSev·0.5·[ratio>0]) · 100
final = clamp(base - pen, 0, 100)
```
드리프트를 가중합에 넣지 않고 감점으로 분리한 이유 — 평균이 높아도 치명적
구간이 있으면 사용할 수 없는 영상이며, 가중합에 섞으면 그것이 희석된다.

### 실험 결과

대상: Higgsfield 생성 영상 (Seedance 2.0, 1280×720, 4.04초), 합성 인물 레퍼런스 1장
샘플링 6fps, 25 프레임 분석, ruleset qc-v1

| 지표 | 값 |
| --- | --- |
| face_similarity (raw cos) | 0.7810 |
| body_similarity (raw cos) | 0.6996 |
| temporal_face_consistency | 0.5761 |
| temporal_body_consistency | 0.9801 |
| binding_stability | 0.9899 |
| drift 구간 | 2.67 – 3.17초 (사유: face_similarity_drop) |
| max severity | 0.0872 |
| **CREZ Identity Score** | **71.3 / 100** |

**관찰** — 얼굴 시간일관성 0.576 대 신체 0.980. 생성 영상에서 의상·체형은 거의
고정된 채 얼굴만 흔들린다. 두 신호를 독립 산출했기 때문에 드러난 차이이며,
신체를 얼굴에서 파생시키는 구현으로는 관측할 수 없다.

### 이 과정에서 발견·수정한 결함

1. **신체 지표가 얼굴 유사도의 복사본이었다.** `qc.py`가
   `bodySimilarity = faceSimilarity`로 반환하고 있어 5개 지표 중 하나가
   독립 신호가 아니었다. 실제 인코더 산출로 교체했다.
   → 검증: 얼굴 벡터와의 상관 +0.0805, 의상 변경 시 신체만 0.79로 하락

2. **기술자 무음 절단.** 신체 기술자를 설정 차원으로 자르면서 하체 2개 밴드가
   통째로 사라져, 하의 색이 바뀌어도 벡터가 동일했다. 절단을 제거하고 초과 시
   명시적으로 실패시킨다.

3. **기준·대상 크롭 방식 불일치.** 기준은 이미지 전체를, 영상 프레임은 얼굴에서
   유도한 신체 영역을 인코딩해 신체 유사도가 0.38로 나왔다. 기준도 동일하게
   유도하도록 통일하니 0.70으로 정정됐다. 구도 차이가 신원 차이로 둔갑한 사례다.

4. **백분위 경계 성질.** 붕괴 프레임 비율이 백분위와 정확히 같으면 보간이 좋은 값
   쪽으로 당겨 그 백분위는 붕괴를 놓친다(5% 붕괴 → p05 무력, 10% → p10 무력).
   임계 판정에 단일 백분위를 쓰지 않고 min을 함께 본다. 테스트로 고정했다.

### 테스트

engine 49건 (신규 21건) · providers 20건 · api 8건 · worker 5건 · contracts 3건 · shared 11건
Python 25건. 전체 통과.

§22 요구 테스트 대응:
- 같은 이미지 비교 → face 1.0000 / body 1.0000
- 같은 사람 다른 의상 → face 1.0000 유지, body 0.7879 하락
- 연속 동일 프레임 → temporal delta 0.000000
- 백분위·severity·fusion 경계 조건 → `poc-modules.test.ts`

### 커밋

```
0e14bfa feat(engine,ml): Identity Consistency PoC — 인코더 인터페이스와 자체 판정 계층
e6fda1f feat(providers): Higgsfield 생성 API 실연동
785c0ae fix(ml): LOG_LEVEL 대소문자 정규화
c029324 CREZ Digital Identity Content Engine 초기 구현
```

---

## 기록 규칙

CREZ 자체 모듈의 수식이 바뀌면 다음을 남긴다.

1. 알고리즘 버전 (예: Drift Severity v1.0 → v1.1)
2. 변경 전후 수식
3. 변경 이유
4. 동일 입력에 대한 결과 변화
5. 커밋 해시

외부 인코더 교체는 자체 모듈 버전을 올리지 않는다 — 인코더는 교체 가능한
부품이며 판정 구조가 발명의 대상이기 때문이다.
