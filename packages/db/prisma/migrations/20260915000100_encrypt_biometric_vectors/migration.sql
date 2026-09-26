-- 생체 벡터 암호화 (§16, ADR 0003).
-- 얼굴·신체 임베딩과 centroid를 평문 pgvector 컬럼에서 AES-256-GCM 암호문(bytea)으로 옮기고 평문 컬럼을 삭제한다.
-- 암호화에는 애플리케이션 키(BIOMETRIC_ENCRYPTION_KEY)가 필요해 SQL로는 할 수 없다.
-- 그래서 `pnpm db:deploy`(prisma/deploy.ts)가 이 마이그레이션 전에 암호문 컬럼을 채우고, 끝난 뒤 VACUUM FULL을 한다.

-- 암호문 컬럼. 선행 단계가 이미 만들었을 수 있다.
ALTER TABLE "identity_embedding" ADD COLUMN IF NOT EXISTS "vector_enc" BYTEA;
ALTER TABLE "identity_profile" ADD COLUMN IF NOT EXISTS "face_centroid_enc" BYTEA;
ALTER TABLE "identity_profile" ADD COLUMN IF NOT EXISTS "body_centroid_enc" BYTEA;
ALTER TABLE "source_track" ADD COLUMN IF NOT EXISTS "face_centroid_enc" BYTEA;

-- 암호화되지 않은 평문이 남아 있으면 삭제 전에 멈춘다. 평문 컬럼 삭제는 되돌릴 수 없다.
DO $$
DECLARE
  pending bigint;
BEGIN
  SELECT
      (SELECT count(*) FROM identity_embedding WHERE vector IS NOT NULL AND vector_enc IS NULL)
    + (SELECT count(*) FROM identity_profile
         WHERE (face_centroid IS NOT NULL AND face_centroid_enc IS NULL)
            OR (body_centroid IS NOT NULL AND body_centroid_enc IS NULL))
    + (SELECT count(*) FROM source_track WHERE face_centroid IS NOT NULL AND face_centroid_enc IS NULL)
  INTO pending;
  IF pending > 0 THEN
    RAISE EXCEPTION '암호화되지 않은 생체 벡터 %건이 있습니다 — prisma migrate deploy 대신 pnpm db:deploy로 적용하세요', pending;
  END IF;
END $$;

-- 암호문에는 ANN 인덱스를 걸 수 없다. 유사도 계산은 원래 앱·ML 서비스에서 하므로 쓰이던 인덱스가 아니다.
DROP INDEX IF EXISTS "identity_embedding_vector_hnsw";
DROP INDEX IF EXISTS "identity_profile_face_centroid_hnsw";
DROP INDEX IF EXISTS "source_track_face_centroid_hnsw";

ALTER TABLE "identity_embedding" DROP COLUMN "vector";
ALTER TABLE "identity_embedding" ALTER COLUMN "vector_enc" SET NOT NULL;
ALTER TABLE "identity_profile" DROP COLUMN "face_centroid", DROP COLUMN "body_centroid";
ALTER TABLE "source_track" DROP COLUMN "face_centroid";
