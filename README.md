# CREZ Digital Identity Content Engine (crez-dice)

디지털 신원 라이브러리 기반의 다중 인물 신원 일관성 유지 및 영상 콘텐츠 생성 시스템.

구현 기준 문서는 **기술명세서 v1.1**이다. 이 저장소의 코드 주석은 명세서의 절 번호(§)를
참조한다. 개념 정의는 기획 초안 v0.1을, 구현 사항은 명세서와 이 README를 원본으로 삼는다.

## 30분 안에 로컬에서 띄우기 (Phase 0 DoD)

전제: Node 20+, pnpm 9, Python 3.11+, Docker, FFmpeg.

```bash
pnpm install
cp .env.example .env

# 인프라 (postgres+pgvector, redis, minio, 버킷 생성)
pnpm infra:up

# 스키마 · 시드 (샘플 identity 5명 + 더미 모델 어댑터 + QC ruleset)
pnpm db:generate
pnpm db:deploy     # 생체 벡터 암호화 이행 포함 — prisma migrate deploy를 직접 쓰지 않는다
pnpm db:seed

# ML 서비스 — 실제 추론(YuNet + SFace, CPU) 또는 mock
cd services/ml
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./scripts/download_models.sh          # MIT/Apache 2.0 가중치만 내려받는다
ML_MODE=cpu ./.venv/bin/uvicorn app.main:app --port 8000
# GPU도 모델도 없이 전체 플로우만 돌리려면: ML_MODE=mock

# api + worker + web
pnpm dev
```

- API `http://localhost:3001/api/v1` · OpenAPI `http://localhost:3001/api/docs`
- 웹 `http://localhost:3000`
- MinIO 콘솔 `http://localhost:9001` (crezadmin / crezadmin)

VS Code에서는 `.vscode/launch.json`의 **"전체 스택 (api + worker + web + ml)"** 컴파운드
구성으로 네 프로세스를 동시에 디버깅할 수 있다.

개발 인증은 `AUTH_MODE=dev`에서 `x-dev-user` 헤더로 역할을 바꿔 시험한다.
`AUTH_MODE`는 필수다. 없거나 틀린 값이면 api가 기동하지 않고, `dev`는 `NODE_ENV=production`에서
거부된다. 운영은 `AUTH_MODE=oidc`와 `OIDC_ISSUER`·`OIDC_AUDIENCE`를 함께 설정한다(§16).

얼굴·신체 임베딩은 `BIOMETRIC_ENCRYPTION_KEY`로 암호화해 저장한다. `.env.example`의 키는 개발 전용이며
운영에서는 기동이 거부된다 — `openssl rand -hex 32`로 발급하고 비밀 저장소에 백업한다
([ADR 0003](docs/adr/0003-biometric-vector-encryption.md)).

```bash
curl -H "x-dev-user: producer@hicrez.com" http://localhost:3001/api/v1/identities
```

시드 사용자: `owner@` / `admin@` / `producer@` / `operator@` / `viewer@hicrez.com` (§16).

## 구조

```
apps/api      NestJS — 도메인 상태, 권한, 큐 제출, 결과 집계
apps/worker   BullMQ — 생성·QC·재생성·미디어 워커 (프로세스 분리)
apps/web      Next.js 14 — Identity 관리, 프로젝트 편집기, QC 뷰어, ruleset 튜닝
services/ml   FastAPI — 검출·임베딩·트래킹·유사도·QC 채점 (stateless)
packages/contracts  API/ML DTO 단일 출처 (zod → JSON Schema → Pydantic 검증)
packages/db         Prisma 스키마, pgvector 헬퍼, 필드 암호화, 시드
packages/engine     QC 규칙 엔진 · 점수 · 재생성 전략 사다리 · 바인딩 판정
packages/providers  생성 모델 어댑터 + Model Router
packages/shared     에러 코드, 상수, 로거, trace
```

### 판단의 위치

`crez-ml`은 **점수와 원시 시계열만** 반환하고 합격 여부를 판단하지 않는다(§7).
임계값 적용·finding 생성·재생성 여부 결정은 `packages/engine`에 모여 있고, 가중치와
임계값은 코드가 아니라 DB의 `qc_ruleset` 레코드에 있다(§10). 따라서 튜닝에
ML 서비스 재배포가 필요 없고, 적용된 버전이 `qc_run.ruleset_version`에 남아 과거 판정을
재현할 수 있다. 배경은 [ADR 0001](docs/adr/0001-domain-engine-package.md) 참조.

### 파이프라인

```
Identity 등록 → 자산 업로드 → 품질검사 → 임베딩 → 프로파일 빌드(버전)
                                                        │
프로젝트 생성 → 캐스팅(권리 게이트 1 · 프로파일 버전 고정)
             → 소스 영상 분석(검출·트래킹) → 자동 매핑 + 운영자 보정
             → 씬/세그먼트 정의
             → 생성(권리 게이트 2 · Model Router) ──┐
                                                    ▼
                          QC(track 단위 판정) → PASSED
                                    │
                                    ├─ 실패 → 전략 사다리 재생성 (최대 3회)
                                    └─ 한도 초과 → MANUAL_REVIEW (운영자 승인/재요청)
                                                        │
                          마스터 결합(provenance 봉인) → 파생물(9:16 스마트 크롭 등)
                                                        │
                                            배포(권리 게이트 3)
```

## 자주 쓰는 명령

```bash
pnpm dev                 # api + worker + web 동시 실행
pnpm test                # 전체 테스트
pnpm typecheck           # 전체 타입 검사
pnpm licenses:check      # §7.4 금지 라이선스 스캔
pnpm contracts:jsonschema # contracts 변경 후 반드시 실행하고 커밋
pnpm db:migrate          # 스키마 변경 시
cd services/ml && pytest # ML 서비스 테스트 (mock 모드)
```

워커는 담당 큐를 나눠 배치할 수 있다. GPU 노드에는 분석·QC만 띄운다.

```bash
WORKER_QUEUES=analysis,qc pnpm --filter @crez/worker dev
```

## Identity Consistency 분석 (PoC)

기준 인물 이미지와 생성 영상을 비교해 신원 일관성을 정량 평가한다.

```bash
pnpm infra:up                       # postgres·redis·minio
cd services/ml && ML_MODE=cpu ./.venv/bin/uvicorn app.main:app --port 8000 &

pnpm analyze -- \
  --reference ./samples/reference \
  --video ./samples/generated.mp4 \
  --output ./outputs \
  --sampling-fps 2
```

산출물 — `identity_report.json` · `frame_metrics.csv` · `similarity_graph.png`

### 무엇이 오픈소스이고 무엇이 CREZ 구현인가

이 구분이 코드와 문서에서 명확해야 한다.

**Open-source components** — 특징 추출만 담당한다

| 구성요소 | 역할 |
| --- | --- |
| YuNet (MIT) | 얼굴 검출 |
| SFace (Apache-2.0) | 얼굴 임베딩 |
| ByteTrack 방식 (MIT 알고리즘) | 다중 인물 추적 |
| AdaFace · OSNet · FastReID | **research 트랙 — 비교 실험 전용, 상업 이용 불가** |

**CREZ proprietary implementation** — 판정과 융합

| 모듈 | 위치 |
| --- | --- |
| Reference Identity Aggregation | `services/ml/app/services/aggregate.py` |
| Body Appearance Encoder | `services/ml/app/encoders/body_appearance.py` |
| Frame-level Identity Scoring | `services/ml/app/services/qc.py` |
| Temporal Face / Body Consistency | `qc.py` + `packages/engine/src/scoring.ts` |
| Identity Drift Detection | `packages/engine/src/rules.ts` |
| Drift Severity Calculation | `packages/engine/src/severity.ts` |
| Multi-metric Score Fusion | `packages/engine/src/fusion.ts` |
| Statistics / Normalization | `packages/engine/src/{stats,normalize}.ts` |

외부 모델의 출력값을 그대로 CREZ Score로 쓰지 않는다. 인코더는 코사인 유사도
하나만 주고, 그것을 시간축·다중 신호·드리프트와 결합해 점수를 만드는 계층이
CREZ 구현이다. 따라서 인코더를 교체해도 판정 구조는 유지된다.

### 인코더 교체

모델 경로는 코드에 없고 `services/ml/configs/encoders.yaml`에 있다.

```bash
CREZ_FACE_ENCODER=sface pnpm analyze -- ...

# research 트랙은 명시적으로 켜야 한다 (가중치 상업 이용 불가)
CREZ_ALLOW_RESEARCH_ENCODERS=1 CREZ_FACE_ENCODER=adaface pnpm analyze -- ...
```

라이선스 근거와 격리 방식은 [LICENSE_NOTICE.md](LICENSE_NOTICE.md),
개발 이력과 수식 변경은 [DEVELOPMENT_LOG.md](DEVELOPMENT_LOG.md)를 참조한다.

## 생성 모델 연동

기본은 `mock`(FFmpeg 컬러바)이며 실제 생성에는 Higgsfield를 연동한다.

```bash
# .env
HIGGSFIELD_KEY_ID=...
HIGGSFIELD_KEY_SECRET=...

# 모델 활성화 (시드는 안전을 위해 DISABLED로 등록한다)
curl -X PATCH -H "x-dev-user: admin@hicrez.com" -H "content-type: application/json" \
  -d '{"status":"ACTIVE"}' \
  http://localhost:3001/api/v1/models/higgsfield-veo31-reference/status
```

| 모델 code | 엔드포인트 | 모드 | 비고 |
| --- | --- | --- | --- |
| `higgsfield-veo31-reference` | `/veo3.1/reference-to-video` | `reference` | 레퍼런스 1~3장으로 신원 조건화 |
| `higgsfield-veo31-i2v` | `/veo3.1/image-to-video` | `i2v` | 시작 프레임 1장 |
| `higgsfield-kling25-pro-i2v` | `/kling-video/v2.5-turbo/pro/image-to-video` | `i2v` | 5·10초 |
| `higgsfield-sora2-i2v` | `/sora-2/image-to-video` | `i2v` | 최대 12초 |

**계정에서 실제로 열리는 모델은 다르다.** 2026-09-16 점검 기준 veo3.1 계열과 sora2는
`model_not_found`·`model_disabled`라 시드에서 DISABLED로 둔다. 호출되는 것은 kling 계열
(`/kling-video/v2.5-turbo/{pro,standard}/image-to-video`, `/kling-video/v2.1/{master,pro,standard}/image-to-video`)뿐이며
이들만 ACTIVE다. veo3.1 접근이 열리면 `PATCH /models/{code}/status`로 켠다.
`reference` 방식(레퍼런스 1~3장으로 신원 조건화)은 veo3.1에만 있으므로, kling만으로는
시작 이미지 1장짜리 i2v만 가능하다.

화면 비율은 프로젝트 설정 `config.aspectRatio`(`16:9` 기본, `9:16` 선택)로 정한다.
kling은 비율 파라미터가 없어 시작 이미지 비율을 그대로 따르며 그 사실이 경고 로그로 남는다.

QC가 실패해도 **과금 모델은 자동 재생성하지 않는다**(`PAID_AUTO_REGEN_LIMIT`, 기본 0).
구간은 `MANUAL_REVIEW`로 올라가고 운영자가 `POST /segments/{id}/regenerate`로만 다시 돌린다.
제출한 요청의 취소는 워커가 제공자에 전달하지만, 이미 진행 중이면 제공자가 거부할 수 있다 —
그 경우 과금은 막지 못하고 감사 로그에 `PROVIDER_CANCEL_REFUSED`로 남는다.

연동 시 주의할 제약이 셋 있다.

- **pose-guided 모드가 없다.** Higgsfield는 안무 궤적을 직접 조건화하는 엔드포인트를
  제공하지 않으므로, 프로젝트 `config.requiredMode`를 `reference` 또는 `i2v`로 두어야 한다.
- **길이가 고정 enum이다.** veo3.1은 4·6·8초만 받는다. 세그먼트 길이는 가장 가까운 값으로
  스냅되며 그 사실이 경고 로그로 남는다.
- **레퍼런스는 공개 URL이어야 한다.** 워커가 제출 직전에 presigned URL을 만들어 넘긴다.
  로컬 MinIO 주소는 외부에서 접근할 수 없으므로 실연동 테스트는 공개 가능한 스토리지가 필요하다.

자격증명이 없으면 어댑터는 **명시적으로 실패한다.** mock으로 조용히 대체되지 않는다 —
"생성된 줄 알았는데 mock이었다"를 막기 위한 의도적 설계다.

## 라이선스 정책

**상업 이용이 명시적으로 허용된 퍼미시브 라이선스 모델만 사용한다**(§7.1).
Phase 1~2 스택(YuNet MIT + SFace Apache 2.0 + ByteTrack 방식)은 라이선스 비용이 0원이며
소스 공개 의무도 없다.

InsightFace 사전학습 가중치, Ultralytics YOLO(AGPL), OpenPose 등은 **코드베이스 반입
금지**이며, CI의 라이선스 스캐너가 빌드를 실패시킨다. 전체 대장은
[docs/licenses.md](docs/licenses.md)에 있다.

FFmpeg는 LGPL 빌드를 쓰고 GPL 코덱(x264/x265)은 링크하지 않는다(§7.3).

## 특허

청구 요소와 구현 모듈의 매핑은 [docs/patent-mapping.md](docs/patent-mapping.md)에서
유지한다. 청구항은 특정 얼굴인식 모델에 종속되지 않으며, 임베딩 모델을 교체해도
`identity_embedding`의 `model_name`·`model_version`·`dim`과 프로파일 버전 고정 구조 덕에
기존 프로젝트가 영향받지 않는다.

## 아직 하지 않은 것

명세서 기준으로 Phase 0~3의 실행 골격과 Phase 4 파생물 생성까지 구현되어 있다.
남은 범위는 명세서 §19·§22를 따른다.

- 라벨링 검증셋과 모델 성능 실측 (§7.2, Phase 2 필수 산출물) — QC 임계값의 초기값은
  기획 초안 제안치이며, 검증셋 없이는 재현율·오탐률을 측정할 수 없다.
- 자체 호스팅 생성 모델 어댑터 (§19 Phase 3) — 인터페이스와 라우터는 준비되어 있고
  어댑터 구현만 추가하면 된다.
- 배포 자동화 및 워터마크 (§19 Phase 5, §22 C2PA vs 비가시 워터마크 미결정)
- 멀티테넌시 (§19 Phase 6)
- 생체정보 관련 법무 검토 (§22) — 라이선스와 별개로 남아 있는 사안이다.

## 생성 지출 한도와 장애 복구

조직의 기본 월 한도는 **300,000원**이다. `spend_policy.credit_unit_price_krw`가 비어 있으면
유료 생성을 차단한다. 월 집계 기준은 UTC이며, 일반 생성과 수동·자동 재생성에 같은 한도를 적용한다.
API는 큐 제출 전에 예상 비용을 예약하고 워커는 제공자 제출 직전에 다시 검사한다.
`spend_entry`는 프로젝트 삭제와 무관하게 남는다. 미제출 취소는 예약을 해제하지만, 제공자에
제출했거나 접수 여부가 불명확한 실패·취소는 환불을 확인하지 않았으므로 추정액을 유지한다.

배포 시 API와 워커를 중지한 상태에서 `pnpm db:deploy`로 마이그레이션을 적용한 뒤 함께 재시작한다.
기존 기본값 100,000원 중 운영자가 변경하지 않은 정책은 300,000원으로 이관하며 별도 설정은 유지한다.
기존 생성 기록의 비용도 이관한다. 이미 삭제된 기록은 이관할 수 없다.

결과 저장·생성 성공·비용 정산은 한 DB 트랜잭션으로 확정한다. QC 큐 인계와 생성 큐 인계에
실패하면 기본 60초 주기의 reconciler가 재전달한다. 동일한 큐 작업 ID를 보존하므로 ACK 유실도
중복 제출로 이어지지 않는다. API와 워커를 함께 업데이트해야 이 복구 경로가 작동한다.

DB/큐 통합 테스트는 마이그레이션을 적용한 별도 PostgreSQL과 Redis에서 실행한다.
테스트 DB 이름은 `_test` 또는 `_review`로 끝나야 한다. 외부 유료 생성 호출은 테스트 대역으로 대체한다.

```sh
TEST_DATABASE_URL=postgresql://crez:crez@localhost:5432/crez_test \
TEST_REDIS_URL=redis://localhost:6379 pnpm test:integration
```
