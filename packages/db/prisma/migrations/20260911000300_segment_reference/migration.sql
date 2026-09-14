-- 세그먼트 프롬프트에 붙이는 참고 이미지 (배경·의상·헤어).
-- 인물 신원 레퍼런스(identity_asset)와 달리 프로젝트·구간에 속한 연출 자료다.
-- 생성에 쓰인 뒤 삭제하면 active=false로 보존해 생성 이력(job params의 referenceId)을 설명할 수 있게 한다.
CREATE TABLE "segment_reference" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "slot_index" INTEGER,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "segment_reference_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "segment_reference_kind_check" CHECK ("kind" IN ('BACKGROUND', 'OUTFIT', 'HAIR')),
    -- 배경은 특정 인물에 속하지 않는다
    CONSTRAINT "segment_reference_slot_check" CHECK ("kind" <> 'BACKGROUND' OR "slot_index" IS NULL)
);

CREATE INDEX "segment_reference_segment_id_idx" ON "segment_reference"("segment_id");

ALTER TABLE "segment_reference" ADD CONSTRAINT "segment_reference_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "segment_reference" ADD CONSTRAINT "segment_reference_segment_id_fkey"
    FOREIGN KEY ("segment_id") REFERENCES "segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
