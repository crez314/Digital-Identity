-- 기본 월 한도 30만원. 운영자가 따로 지정한 금액/null은 보존한다.
ALTER TABLE spend_policy ALTER COLUMN monthly_budget_krw SET DEFAULT 300000;
UPDATE spend_policy SET monthly_budget_krw = 300000, updated_at = now()
WHERE monthly_budget_krw = 100000 AND updated_by IS NULL;
INSERT INTO spend_policy (org_id, monthly_budget_krw, updated_at)
SELECT id, 300000, now() FROM organization ON CONFLICT (org_id) DO NOTHING;

-- 의도적으로 project/segment/job FK를 두지 않는다: 삭제 후에도 과금은 남는다.
CREATE TABLE spend_entry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  project_id UUID NOT NULL,
  segment_id UUID NOT NULL,
  attempt INTEGER NOT NULL,
  amount_credits DECIMAL(14,4) NOT NULL CHECK (amount_credits >= 0),
  status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','SUBMITTED','SETTLED','RELEASED')),
  dispatch JSONB,
  dispatched_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX spend_entry_segment_id_attempt_key ON spend_entry(segment_id, attempt);
CREATE INDEX spend_entry_org_id_created_at_idx ON spend_entry(org_id, created_at);
CREATE INDEX spend_entry_status_dispatched_at_idx ON spend_entry(status, dispatched_at);

-- 기존 확정 비용 및 제출된 유료 작업을 이관한다. 실패/취소라도 과금 여부가 불명확하면 추정액을 유지한다.
-- 고정 길이는 snapDuration과 동일하게 가장 가까운 값, 동률이면 배열의 앞쪽을 쓴다.
INSERT INTO spend_entry (org_id, project_id, segment_id, attempt, amount_credits, status, created_at)
SELECT p.org_id, p.id, s.id, j.attempt,
  GREATEST(0, COALESCE(j.cost_amount, COALESCE(d.seconds, GREATEST(0, s.end_ms - s.start_ms) / 1000.0) * COALESCE(m.cost_per_second, 0))),
  CASE WHEN j.cost_amount IS NOT NULL THEN 'SETTLED'
       WHEN j.status = 'QUEUED' AND j.provider_job_id IS NULL THEN 'RESERVED'
       ELSE 'SUBMITTED' END,
  j.created_at
FROM generation_job j JOIN segment s ON s.id = j.segment_id
JOIN project p ON p.id = s.project_id JOIN ai_model m ON m.id = j.model_id
LEFT JOIN LATERAL (
  SELECT value::numeric AS seconds
  FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(m.capabilities->'durations') = 'array'
    THEN m.capabilities->'durations' ELSE '[]'::jsonb END) WITH ORDINALITY
  ORDER BY abs(value::numeric - GREATEST(0, s.end_ms - s.start_ms) / 1000.0), ordinality LIMIT 1
) d ON true
WHERE m.code NOT LIKE 'mock%' AND COALESCE(m.capabilities->>'billable', '') <> 'false'
  AND (m.capabilities->>'billable' = 'true' OR m.provider = 'EXTERNAL_API')
  AND (j.cost_amount IS NOT NULL OR j.status IN ('QUEUED','SUBMITTED','RUNNING') OR j.provider_job_id IS NOT NULL);

ALTER TABLE generation_output ADD COLUMN qc_queued_at TIMESTAMPTZ(6);
-- 이미 QC를 받은 결과는 재검사하지 않는다.
UPDATE generation_output o SET qc_queued_at = o.created_at
WHERE EXISTS (SELECT 1 FROM qc_run q WHERE q.output_id = o.id);
