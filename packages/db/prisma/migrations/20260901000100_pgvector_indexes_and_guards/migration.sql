-- §4.2: 임베딩 ANN 인덱스. Prisma가 표현하지 못하는 부분을 raw SQL로 보완한다.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE INDEX IF NOT EXISTS identity_embedding_vector_hnsw
  ON identity_embedding USING hnsw (vector vector_cosine_ops);

CREATE INDEX IF NOT EXISTS identity_profile_face_centroid_hnsw
  ON identity_profile USING hnsw (face_centroid vector_cosine_ops);

CREATE INDEX IF NOT EXISTS source_track_face_centroid_hnsw
  ON source_track USING hnsw (face_centroid vector_cosine_ops);

-- §14.2: 감사 로그는 append-only. 애플리케이션 경로로 수정·삭제할 수 없다.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (spec §14.2): % denied', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- §10: 활성 ruleset은 동시에 하나만 존재해야 한다.
CREATE UNIQUE INDEX IF NOT EXISTS qc_ruleset_single_active
  ON qc_ruleset ((is_active)) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS routing_ruleset_single_active
  ON routing_ruleset ((is_active)) WHERE is_active;
