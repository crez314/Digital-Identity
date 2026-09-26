-- 폴링 생존 신호. 없으면 reconciler가 오래 걸리는 생성마다 폴링 체인을 60초에 하나씩 새로 만든다.
ALTER TABLE "generation_job" ADD COLUMN IF NOT EXISTS "last_polled_at" TIMESTAMPTZ(6);
