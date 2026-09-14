-- 자산 품질검사 판정 근거 (§6.1, §17 CREZ-IDN-002).
-- 슬롯에 맞지 않는 사진(얼굴 슬롯의 전신 사진 등)은 품질 점수가 높아도 제외되므로,
-- 점수만으로는 이유를 알 수 없다. 사유 코드와 판정에 쓴 측정값·임계값을 함께 남긴다.
ALTER TABLE "identity_asset" ADD COLUMN "reject_reason" TEXT;
ALTER TABLE "identity_asset" ADD COLUMN "quality_detail" JSONB;
