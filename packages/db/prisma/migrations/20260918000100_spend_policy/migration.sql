-- 조직 단위 지출 한도 (§12.1).
-- 생성 한 번이 수십 건의 유료 요청이고, 제출한 요청은 제공자가 취소를 거부할 수 있어 되돌릴 수 없다.
-- 한도는 사후 정산이 아니라 제출 전에 건다.
CREATE TABLE IF NOT EXISTS "spend_policy" (
  "org_id"                UUID PRIMARY KEY REFERENCES "organization"("id") ON DELETE CASCADE,
  -- 월 상한(원). NULL이면 금액 상한 없음
  "monthly_budget_krw"    DECIMAL(14, 2),
  -- 1 크레딧의 원화 단가. 견적은 크레딧으로 나오므로 이 값이 있어야 원화 상한을 적용할 수 있다
  "credit_unit_price_krw" DECIMAL(12, 4),
  -- 단가를 모르는 동안 유료 생성을 막을지. 얼마가 나갈지 모르는 채로 돈을 쓰지 않는다
  "block_when_unpriced"   BOOLEAN NOT NULL DEFAULT true,
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_by"            UUID
);

-- 기존 조직에 기본 한도를 넣는다. 단가는 계약 정보라 비워 두고, 채우기 전까지는 유료 생성을 막는다.
INSERT INTO "spend_policy" ("org_id", "monthly_budget_krw")
SELECT o."id", 100000 FROM "organization" o
ON CONFLICT ("org_id") DO NOTHING;
