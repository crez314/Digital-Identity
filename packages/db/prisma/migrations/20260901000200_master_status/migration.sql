-- 마스터 결합 상태. 결합이 끝나야 storage_key에 실체가 생기므로,
-- 파생물 생성과 배포는 COMPLETED에서만 허용한다(§13, §14.1 게이트 3).
ALTER TABLE "master_video" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING';

-- 이미 결합이 끝난 기존 마스터는 COMPLETED로 본다.
UPDATE "master_video" SET "status" = 'COMPLETED' WHERE "duration_ms" > 0;
