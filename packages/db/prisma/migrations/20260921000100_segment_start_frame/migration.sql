-- 구간의 시작 프레임을 사람이 지정할 수 있게 한다 (§12.1).
--
-- image-to-video는 시작 이미지가 옷·구도를 결정하는데, 그 이미지는 identity_asset에서만
-- 골라졌다. 의상을 바꾼 영상을 만들 방법이 없었다. 참고 이미지(OUTFIT)로 넘기는 것도 안 된다 —
-- 이미지를 1장만 받는 제공자는 인물 레퍼런스가 그 자리를 써서 첨부가 통째로 버려진다.
--
-- 그래서 START_FRAME 종류를 두고, 워커가 첨부가 아니라 0번 위치의 대표 레퍼런스로 치환한다.
ALTER TABLE "segment_reference" DROP CONSTRAINT "segment_reference_kind_check";
ALTER TABLE "segment_reference" ADD CONSTRAINT "segment_reference_kind_check"
    CHECK ("kind" IN ('BACKGROUND', 'OUTFIT', 'HAIR', 'START_FRAME'));

-- 시작 프레임은 구간 전체의 첫 장면이라 인물 위치에 속하지 않는다.
-- 0은 받아 준다 — 캐스트 0번을 가리키는 것으로 읽히고 실제 치환 대상과 같다.
ALTER TABLE "segment_reference" ADD CONSTRAINT "segment_reference_start_frame_slot_check"
    CHECK ("kind" <> 'START_FRAME' OR "slot_index" IS NULL OR "slot_index" = 0);

-- 구간당 살아 있는 시작 프레임은 하나여야 한다. 둘이면 워커가 먼저 올린 쪽을 말없이 고르고,
-- 화면에는 둘 다 보여서 어느 것이 쓰였는지 설명할 수 없다. API에서도 막지만 DB에서 못을 박는다.
CREATE UNIQUE INDEX "segment_reference_one_start_frame"
    ON "segment_reference"("segment_id")
    WHERE "kind" = 'START_FRAME' AND "active";
