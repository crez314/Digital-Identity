-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "legal_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_asset" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "asset_type" TEXT NOT NULL,
    "capture_slot" TEXT,
    "expression" TEXT,
    "storage_key" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "fps" DECIMAL(6,3),
    "quality_score" DECIMAL(5,4),
    "is_usable" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_embedding" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "asset_id" UUID,
    "kind" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "model_version" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "vector" vector(512) NOT NULL,
    "quality" DECIMAL(5,4),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_embedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_profile" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "face_centroid" vector(512),
    "body_centroid" vector(256),
    "face_variance" DECIMAL(6,5),
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "model_bundle" JSONB NOT NULL DEFAULT '{}',
    "built_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_rights" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "owner_name" TEXT NOT NULL,
    "contract_ref" TEXT,
    "consent_status" TEXT NOT NULL,
    "allowed_usage" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "restricted_usage" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "territories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "commercial_use" BOOLEAN NOT NULL DEFAULT false,
    "training_permitted" BOOLEAN NOT NULL DEFAULT false,
    "synthetic_permitted" BOOLEAN NOT NULL DEFAULT false,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "document_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_rights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rights_check" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "gate" TEXT NOT NULL,
    "usage_type" TEXT NOT NULL,
    "territory" TEXT,
    "allowed" BOOLEAN NOT NULL,
    "results" JSONB NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rights_check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "project_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_cast" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "slot_index" INTEGER NOT NULL,
    "role_label" TEXT,
    "appearance" JSONB NOT NULL DEFAULT '{}',
    "rights_check_id" UUID,

    CONSTRAINT "project_cast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_video" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "fps" DECIMAL(6,3) NOT NULL DEFAULT 30,
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "analysis_status" TEXT NOT NULL DEFAULT 'PENDING',
    "tracks_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_track" (
    "id" UUID NOT NULL,
    "source_video_id" UUID NOT NULL,
    "track_index" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "timeline_key" TEXT NOT NULL,
    "face_centroid" vector(512),
    "quality" DECIMAL(5,4),

    CONSTRAINT "source_track_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cast_mapping" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "source_track_id" UUID NOT NULL,
    "project_cast_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "confidence" DECIMAL(5,4),
    "confirmed_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cast_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "scene_index" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "prompt" TEXT,
    "style" JSONB,

    CONSTRAINT "scene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segment" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "scene_id" UUID,
    "segment_index" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "accepted_output_id" UUID,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "accept_reason" TEXT,
    "accepted_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT,
    "capabilities" JSONB NOT NULL,
    "cost_per_second" DECIMAL(10,4),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_job" (
    "id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "model_id" UUID NOT NULL,
    "routing_trace" JSONB NOT NULL,
    "params" JSONB NOT NULL,
    "seed" BIGINT,
    "status" TEXT NOT NULL,
    "provider_job_id" TEXT,
    "cost_amount" DECIMAL(12,4),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "error_code" TEXT,
    "error_detail" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_output" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "duration_ms" INTEGER,
    "fps" DECIMAL(6,3),
    "width" INTEGER,
    "height" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_output_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_run" (
    "id" UUID NOT NULL,
    "output_id" UUID NOT NULL,
    "ruleset_version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "overall_score" DECIMAL(6,3),
    "per_identity" JSONB,
    "series_key" TEXT,
    "model_bundle" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qc_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_finding" (
    "id" UUID NOT NULL,
    "qc_run_id" UUID NOT NULL,
    "identity_id" UUID,
    "finding_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "qc_finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regeneration_task" (
    "id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "source_qc_run_id" UUID NOT NULL,
    "strategy" JSONB NOT NULL,
    "result_job_id" UUID,
    "outcome" TEXT,
    "score_before" DECIMAL(6,3),
    "score_after" DECIMAL(6,3),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regeneration_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_ruleset" (
    "version" TEXT NOT NULL,
    "weights" JSONB NOT NULL,
    "thresholds" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qc_ruleset_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "routing_ruleset" (
    "version" TEXT NOT NULL,
    "weights" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routing_ruleset_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "master_video" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "provenance" JSONB NOT NULL,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "master_video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "derivative" (
    "id" UUID NOT NULL,
    "master_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "aspect_ratio" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "metadata" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "derivative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "org_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "identity_id" UUID,
    "project_id" UUID,
    "payload" JSONB NOT NULL,
    "trace_id" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "identity_org_id_code_key" ON "identity"("org_id", "code");

-- CreateIndex
CREATE INDEX "identity_asset_identity_id_asset_type_idx" ON "identity_asset"("identity_id", "asset_type");

-- CreateIndex
CREATE INDEX "identity_embedding_identity_id_kind_idx" ON "identity_embedding"("identity_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "identity_profile_identity_id_version_key" ON "identity_profile"("identity_id", "version");

-- CreateIndex
CREATE INDEX "identity_rights_identity_id_created_at_idx" ON "identity_rights"("identity_id", "created_at");

-- CreateIndex
CREATE INDEX "project_org_id_status_idx" ON "project"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "project_cast_project_id_identity_id_key" ON "project_cast"("project_id", "identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_cast_project_id_slot_index_key" ON "project_cast"("project_id", "slot_index");

-- CreateIndex
CREATE UNIQUE INDEX "source_track_source_video_id_track_index_key" ON "source_track"("source_video_id", "track_index");

-- CreateIndex
CREATE UNIQUE INDEX "cast_mapping_project_id_source_track_id_key" ON "cast_mapping"("project_id", "source_track_id");

-- CreateIndex
CREATE UNIQUE INDEX "scene_project_id_scene_index_key" ON "scene"("project_id", "scene_index");

-- CreateIndex
CREATE INDEX "segment_project_id_status_idx" ON "segment"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "segment_project_id_segment_index_key" ON "segment"("project_id", "segment_index");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_code_key" ON "ai_model"("code");

-- CreateIndex
CREATE INDEX "generation_job_status_created_at_idx" ON "generation_job"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "generation_job_segment_id_attempt_key" ON "generation_job"("segment_id", "attempt");

-- CreateIndex
CREATE INDEX "qc_run_output_id_created_at_idx" ON "qc_run"("output_id", "created_at");

-- CreateIndex
CREATE INDEX "qc_finding_qc_run_id_finding_type_idx" ON "qc_finding"("qc_run_id", "finding_type");

-- CreateIndex
CREATE INDEX "regeneration_task_segment_id_created_at_idx" ON "regeneration_task"("segment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "master_video_project_id_version_key" ON "master_video"("project_id", "version");

-- CreateIndex
CREATE INDEX "audit_log_identity_id_occurred_at_idx" ON "audit_log"("identity_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_project_id_occurred_at_idx" ON "audit_log"("project_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity" ADD CONSTRAINT "identity_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_asset" ADD CONSTRAINT "identity_asset_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_embedding" ADD CONSTRAINT "identity_embedding_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_embedding" ADD CONSTRAINT "identity_embedding_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "identity_asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_profile" ADD CONSTRAINT "identity_profile_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_rights" ADD CONSTRAINT "identity_rights_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_cast" ADD CONSTRAINT "project_cast_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_cast" ADD CONSTRAINT "project_cast_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_cast" ADD CONSTRAINT "project_cast_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "identity_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_cast" ADD CONSTRAINT "project_cast_rights_check_id_fkey" FOREIGN KEY ("rights_check_id") REFERENCES "rights_check"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_video" ADD CONSTRAINT "source_video_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_track" ADD CONSTRAINT "source_track_source_video_id_fkey" FOREIGN KEY ("source_video_id") REFERENCES "source_video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cast_mapping" ADD CONSTRAINT "cast_mapping_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cast_mapping" ADD CONSTRAINT "cast_mapping_source_track_id_fkey" FOREIGN KEY ("source_track_id") REFERENCES "source_track"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cast_mapping" ADD CONSTRAINT "cast_mapping_project_cast_id_fkey" FOREIGN KEY ("project_cast_id") REFERENCES "project_cast"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cast_mapping" ADD CONSTRAINT "cast_mapping_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene" ADD CONSTRAINT "scene_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segment" ADD CONSTRAINT "segment_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segment" ADD CONSTRAINT "segment_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "ai_model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_output" ADD CONSTRAINT "generation_output_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "generation_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_run" ADD CONSTRAINT "qc_run_output_id_fkey" FOREIGN KEY ("output_id") REFERENCES "generation_output"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_finding" ADD CONSTRAINT "qc_finding_qc_run_id_fkey" FOREIGN KEY ("qc_run_id") REFERENCES "qc_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_finding" ADD CONSTRAINT "qc_finding_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regeneration_task" ADD CONSTRAINT "regeneration_task_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regeneration_task" ADD CONSTRAINT "regeneration_task_source_qc_run_id_fkey" FOREIGN KEY ("source_qc_run_id") REFERENCES "qc_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regeneration_task" ADD CONSTRAINT "regeneration_task_result_job_id_fkey" FOREIGN KEY ("result_job_id") REFERENCES "generation_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_video" ADD CONSTRAINT "master_video_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "derivative" ADD CONSTRAINT "derivative_master_id_fkey" FOREIGN KEY ("master_id") REFERENCES "master_video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

