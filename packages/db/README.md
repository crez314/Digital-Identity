# @crez/db

Prisma 스키마와 pgvector 접근 계층 (기술명세서 §4).

## 마이그레이션 작성 시 주의

`prisma migrate diff`는 **Prisma가 모르는 객체를 삭제 대상으로 잡는다.** 이 스키마에는
Prisma가 표현하지 못해 raw SQL로 만든 것들이 있다.

- `identity_embedding` / `identity_profile` / `source_track`의 **HNSW 코사인 인덱스** (§4.2)
- `audit_log`의 **append-only 트리거** (§14.2)
- `qc_ruleset` / `routing_ruleset`의 **단일 활성 레코드 부분 유니크 인덱스** (§10)

이들은 `20260901000100_pgvector_indexes_and_guards`에 정의되어 있다.
`migrate diff`로 새 마이그레이션을 만들면 생성된 SQL에 `DROP INDEX ...hnsw` 같은 줄이
섞여 들어오므로, **커밋 전에 반드시 제거**해야 한다. 지우면 ANN 검색이 순차 스캔으로
떨어지고 감사 로그 보호가 사라진다.

```bash
pnpm --filter @crez/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script

# 생성된 SQL에서 아래 패턴이 있으면 삭제한다
#   DROP INDEX "identity_embedding_vector_hnsw"
#   DROP INDEX "identity_profile_face_centroid_hnsw"
#   DROP INDEX "source_track_face_centroid_hnsw"
```

적용 후 확인:

```sql
SELECT indexname FROM pg_indexes WHERE indexname LIKE '%hnsw%';   -- 3건이어야 한다
UPDATE audit_log SET action='x';                                   -- 반드시 실패해야 한다
```

## 벡터 컬럼

`vector` 타입은 Prisma가 매핑하지 못하므로 `Unsupported`로 선언하고 읽기/쓰기는
`src/vector.ts`의 raw SQL 헬퍼로 처리한다. SFace(128차원)를 `vector(512)`에 저장하는
근거는 [ADR 0002](../../docs/adr/0002-embedding-dimension-padding.md)를 참조.
