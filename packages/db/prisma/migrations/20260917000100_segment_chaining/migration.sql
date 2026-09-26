-- 컷 없이 이어지는 장면을 위해 앞 구간의 마지막 프레임을 시작 프레임으로 쓰는 옵션.
-- 기본값 false — 기존 구간의 동작은 그대로다(각자 인물 레퍼런스에서 출발).
ALTER TABLE "segment" ADD COLUMN IF NOT EXISTS "chain_from_previous" BOOLEAN NOT NULL DEFAULT false;
