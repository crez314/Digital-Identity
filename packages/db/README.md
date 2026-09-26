# @crez/db

Prisma 스키마, 생체 벡터 암호화, 벡터 접근 계층 (기술명세서 §4, §16).

## 마이그레이션 적용

`prisma migrate deploy`를 직접 쓰지 말고 **`pnpm db:deploy`** 로 적용한다.
`prisma/deploy.ts`가 마이그레이션 앞뒤로 생체 벡터 암호화 이행을 한다(ADR 0003).

1. 평문 벡터 컬럼이 남아 있으면 암호문 컬럼을 채우고 행마다 복호화해 원본과 같은지 확인한다
2. `prisma migrate deploy`
3. 이행을 했으면 `VACUUM FULL`로 삭제된 평문을 데이터 파일에서 지운다

새 DB나 이미 이행한 DB에서는 1·3을 건너뛴다. `BIOMETRIC_ENCRYPTION_KEY`가 있어야 한다.

`prisma migrate deploy`를 직접 실행하면 `20260915000100_encrypt_biometric_vectors`가 평문만 남은 행을 발견하고
**평문을 지우기 전에 멈춘다.** Prisma가 이 마이그레이션을 실패로 기록하므로 다음처럼 복구한다.

```bash
pnpm --filter @crez/db exec prisma migrate resolve --rolled-back 20260915000100_encrypt_biometric_vectors
pnpm db:deploy
```

## 마이그레이션 작성 시 주의

`prisma migrate diff`는 **Prisma가 모르는 객체를 삭제 대상으로 잡는다.** 이 스키마에는
Prisma가 표현하지 못해 raw SQL로 만든 것들이 있다(`20260901000100_pgvector_indexes_and_guards`).

- `audit_log`의 **append-only 트리거** (§14.2)
- `qc_ruleset` / `routing_ruleset`의 **단일 활성 레코드 부분 유니크 인덱스** (§10)

`migrate diff`로 새 마이그레이션을 만들면 생성된 SQL에 이들을 지우는 줄이 섞여 들어올 수 있으므로
**커밋 전에 반드시 제거**해야 한다. 지우면 감사 로그 보호가 사라진다.

벡터 HNSW 인덱스 3개는 `20260915000100_encrypt_biometric_vectors`에서 삭제했다.
암호문에는 인덱스를 걸 수 없고, DB 벡터 검색은 원래 쓰지 않았다.

적용 후 확인:

```sql
UPDATE audit_log SET action='x';   -- 반드시 실패해야 한다
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_name IN ('identity_embedding','identity_profile','source_track')
   AND column_name IN ('vector','face_centroid','body_centroid');   -- 0건이어야 한다 (평문 컬럼 없음)
```

## 벡터 컬럼

얼굴·신체 벡터는 `src/biometric.ts`가 AES-256-GCM으로 암호화해 `bytea`에 저장한다.
스키마에서는 `Unsupported("bytea")`로 선언해 Prisma 기본 조회 결과에 암호문이 섞이지 않게 하고,
읽기/쓰기는 `src/vector.ts`의 raw SQL 헬퍼로만 한다. 암호문은 저장된 테이블·컬럼·행 ID에 묶여 있어
다른 행으로 옮기면 복호화되지 않는다.

임베딩은 암호화 전과 같이 512차원으로 패딩해 저장하고 `dim`으로 잘라 읽는다.
근거는 [ADR 0002](../../docs/adr/0002-embedding-dimension-padding.md),
암호화 결정은 [ADR 0003](../../docs/adr/0003-biometric-vector-encryption.md)을 참조.
