-- 한 시도(job)당 결과물은 하나여야 한다.
-- 폴링 체인이 겹쳐 같은 job에 결과물이 여러 개 저장되던 시기의 기록을 먼저 하나로 줄인다.
--
-- 중복 결과물에는 중복 QC 기록이 달려 있고, 그중 일부는 재생성 이력(regeneration_task)이 참조한다.
-- 재생성 이력은 "무엇을 보고 다시 만들기로 했는가"라는 판단 근거이므로 지우지 않는다 —
-- 살아남는 QC 기록으로 옮긴다. 중복본은 같은 결과물을 같은 시각에 채점한 사본이라 내용이 같다.

-- 1) job마다 남길 결과물을 정한다.
--    채택된 것 > QC 기록이 있는 것 > 먼저 만들어진 것 순.
--    QC 기록이 있는 쪽을 앞세우는 이유는 2)에서 옮겨 갈 자리가 있어야 하기 때문이다.
CREATE TEMP TABLE _keep_output ON COMMIT DROP AS
SELECT DISTINCT ON (o.job_id) o.job_id, o.id AS output_id
FROM generation_output o
LEFT JOIN segment s ON s.accepted_output_id = o.id
ORDER BY
  o.job_id,
  (s.id IS NOT NULL) DESC,
  (EXISTS (SELECT 1 FROM qc_run q WHERE q.output_id = o.id)) DESC,
  o.created_at ASC;

-- 2) 지워질 QC 기록을 참조하는 재생성 이력을 남는 QC 기록으로 옮긴다
UPDATE regeneration_task r
SET source_qc_run_id = keeper.id
FROM qc_run victim_run
JOIN generation_output victim ON victim.id = victim_run.output_id
JOIN _keep_output k ON k.job_id = victim.job_id AND k.output_id <> victim.id
JOIN LATERAL (
  SELECT q.id FROM qc_run q WHERE q.output_id = k.output_id ORDER BY q.created_at ASC LIMIT 1
) keeper ON TRUE
WHERE r.source_qc_run_id = victim_run.id;

-- 3) 남길 것 외의 결과물을 지운다 (달린 qc_run은 FK CASCADE로 함께 지워진다)
DELETE FROM generation_output victim
USING _keep_output k
WHERE victim.job_id = k.job_id
  AND victim.id <> k.output_id;

-- 4) 앞으로는 DB가 막는다. 이 제약이 중복 저장을 막는 잠금 역할을 한다 —
--    상태를 먼저 SUCCEEDED로 바꿔 선점하면 내려받기 도중 워커가 죽었을 때
--    결과물 없는 성공으로 남아 재시도도 복구 스캔도 건너뛴다.
CREATE UNIQUE INDEX IF NOT EXISTS "generation_output_job_id_key" ON "generation_output" ("job_id");
