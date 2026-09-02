# 특허 청구항 ↔ 구현 매핑

기술명세서 §21에 따라 유지한다. 명세서 작성 시 각 청구 요소가 실제 코드와 데이터로
뒷받침되는지 확인하는 근거로 사용한다.

**특허 가칭** 디지털 신원 라이브러리 기반의 다중 인물 신원 일관성 유지 및 영상 콘텐츠 생성
시스템 및 방법

> **구현 상태 표기** (기술명세서 v1.2와 동기화, 2026-09-02)
> **[구현됨]** 코드·테스트로 확인 · **[부분]** 일부만 동작 · **[계획]** 미구현

## 매핑표

| 청구 요소 (초안 §42) | 구현 모듈 | 소스 위치 | 산출 데이터 |
| --- | --- | --- | --- |
| 복수 정보로부터 디지털 신원 프로파일 구축 및 라이브러리 저장 | Identity Profile Generator | `services/ml/app/services/{face,body,aggregate}.py`, `apps/worker/src/processors/ingest.ts` | `identity_profile.face_centroid`, `attributes`, `model_bundle` |
| 생성 대상 객체와 프로파일 대응 | Identity Binding Engine (§9.1) | `services/ml/app/services/assign.py`, `packages/engine/src/binding.ts`, `apps/worker/src/processors/analysis.ts` | `cast_mapping`, `confidence` |
| 대응관계를 시간적으로 유지하며 생성 | Generation Orchestrator + conditioning 파라미터 | `apps/worker/src/processors/generation.ts`, `packages/providers/src/types.ts` | `generation_job.params`(conditioningStrength, references) |
| 생성 결과에서 신원 특징 추출 및 비교 | Identity Consistency Engine (§9.2, §10.1) | `services/ml/app/services/qc.py`, `services/ml/app/services/tracking.py` | 유사도 시계열, `qc_run.per_identity` |
| 신원 일관성 정보 산출 | QC 규칙 엔진 (ruleset 기반 가중합) | `packages/engine/src/scoring.ts` | `qc_run.overall_score`, `qc_run.ruleset_version` |
| 기준 미달 인물·시간구간 검출 | Error Detection (§10.2) | `packages/engine/src/rules.ts` | `qc_finding` (인물 + 시각 + 유형 + 근거) |
| 생성 조건 변경 후 일부 재생성 | Regeneration Engine (§11) | `packages/engine/src/regeneration.ts`, `apps/worker/src/processors/regeneration.ts` | `regeneration_task.strategy`, 후속 `generation_job` |

**[부분]** 세그먼트 단위 선택적 재생성은 성립하나 **인물 단위는 미구현**이다.
`targetIdentityIds`가 전략에 담기지만 생성 요청 조립부가 소비하지 않는다.
청구 요소 중 "기준 미달 **인물**에 대한 조건 변경"에 해당하므로 우선 보완 대상이다.

### 실측 근거 (2026-09-02)

특허 실시예로 쓸 수 있는 실제 측정 결과다.

| 항목 | 값 |
| --- | --- |
| 변별력 — 동일인 쌍 78건 | 평균 0.7954, 범위 0.6361~0.9865 |
| 변별력 — 타인 쌍 13건 | 평균 0.1434, 범위 0.0752~0.2228 |
| 분리 마진 | 0.652 (겹침 없음) |
| 실제 생성 영상 분석 | face 0.7810 / body 0.6996 / temporal_face 0.5761 / temporal_body 0.9801 |
| CREZ Identity Score | 71.3 / 100 |

산출물: `outputs/discrimination_report.json`, `outputs/identity_report.json`,
`outputs/frame_metrics.csv`, `outputs/similarity_graph.png`

측정 방법과 수식 변경 이력은 `DEVELOPMENT_LOG.md` 참조.

## 모델 비종속성

특허 청구항은 특정 얼굴인식 모델에 종속되지 않는다. 청구 대상은
**프로파일 구축 → 바인딩 → 일관성 산출 → 검출 → 부분 재생성**으로 이어지는 처리 구조이므로,
임베딩 모델이 교체되어도 청구 범위에 영향이 없다.

구현도 이 전제를 지킨다.

- `crez-ml`의 임베딩 엔드포인트는 모델 중립적이다 (`POST /v1/embed/face`는 벡터와
  품질점수만 반환하고 모델명은 `modelBundle`로 알린다).
- `identity_embedding` 테이블이 `model_name`·`model_version`·`dim`을 함께 저장한다.
- 모델을 교체하면 해당 모델로 프로파일을 재빌드하고 신규 버전으로 승격하면 된다.
  기존 프로젝트는 고정된 프로파일 버전을 계속 참조하므로 영향이 없다
  (`project_cast.profile_id`가 버전을 pin한다).

**명세서 작성 시 모델명을 특정하지 말고 "신원 특징정보 추출부"와 같은 기능적 표현을 사용할 것.**

## 구조가 코드로 뒷받침되는 지점

각 청구 요소가 "설명"이 아니라 "동작하는 코드와 저장된 데이터"로 존재하는지 확인하는 체크리스트다.

- [x] 프로파일이 **버전**을 갖고 프로젝트가 특정 버전을 고정한다 (`identity_profile.version`, `project_cast.profile_id`)
- [x] 판정이 프레임이 아니라 **track 단위**로 이뤄진다 (`packages/engine/src/rules.ts`의 최소 지속시간 조건, `trackIndex` 연속성 검사)
- [x] 오류가 **인물 + 시간구간 + 유형 + 근거**로 특정된다 (`qc_finding`)
- [x] 재생성이 무작위 재시도가 아니라 **오류 유형별 결정론적 전략**이다 (`decideStrategy`)
- [x] 전체가 아니라 **해당 세그먼트만** 재생성된다 (`segment`가 생성·QC·재생성의 최소 단위)
- [x] 전략과 결과가 이력으로 축적된다 (`regeneration_task.strategy`, `outcome`)
- [x] 판정 기준이 코드가 아니라 **버전 관리되는 데이터**다 (`qc_ruleset`, `qc_run.ruleset_version`)
