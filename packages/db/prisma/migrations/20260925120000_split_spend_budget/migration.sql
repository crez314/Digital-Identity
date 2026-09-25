-- 한도를 둘로 나눈다.
--   monthly_budget_krw        실패를 뺀 실지출 상한 (제공자는 실패한 요청을 과금하지 않는다)
--   monthly_gross_budget_krw  실패를 포함한 총량 상한 (실패가 쏟아지면 자동으로 멈추게 한다)
ALTER TABLE spend_policy ADD COLUMN monthly_gross_budget_krw DECIMAL(14,2) DEFAULT 500000;
UPDATE spend_policy SET monthly_gross_budget_krw = 500000, updated_at = now()
WHERE monthly_gross_budget_krw IS NULL;

-- 제공자가 실패를 확정한 시도를 담을 상태를 추가한다.
ALTER TABLE spend_entry DROP CONSTRAINT IF EXISTS spend_entry_status_check;
ALTER TABLE spend_entry ADD CONSTRAINT spend_entry_status_check
  CHECK (status IN ('RESERVED','SUBMITTED','SETTLED','FAILED','RELEASED'));

-- 이미 실패·취소로 끝났고 비용이 확정되지 않은 제출 건을 실패로 옮긴다.
-- 접수 여부가 불명확한 건(job이 살아 있는 건)은 그대로 SUBMITTED로 둔다 — 돈이 나갔을 수 있다.
UPDATE spend_entry e SET status = 'FAILED', updated_at = now()
FROM generation_job j
WHERE e.segment_id = j.segment_id AND e.attempt = j.attempt
  AND e.status = 'SUBMITTED' AND j.cost_amount IS NULL
  AND j.status IN ('FAILED', 'CANCELLED');
