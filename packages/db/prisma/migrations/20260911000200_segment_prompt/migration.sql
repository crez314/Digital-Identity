-- 세그먼트별 생성 프롬프트 (§6.3).
-- 한 씬 안에서도 구간마다 동작·구도가 다르므로 프롬프트를 세그먼트 단위로 둔다.
-- 비어 있으면 씬 프롬프트를 기본값으로 쓴다. 실제로 쓴 값은 generation_job.params.prompt에 남는다.
ALTER TABLE "segment" ADD COLUMN "prompt" TEXT;
