import { Prisma } from '@prisma/client';
import { prisma } from './client';

/**
 * pgvector 컬럼 접근 헬퍼.
 * Prisma가 vector 타입을 매핑하지 못하므로 raw SQL로 읽고 쓴다(§4 주석).
 */

export function toVectorLiteral(v: number[]): string {
  return `[${v.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
}

export function parseVectorLiteral(s: string | null): number[] | null {
  if (!s) return null;
  return s.replace(/^\[|\]$/g, '').split(',').filter(Boolean).map(Number);
}

/** §4.2 identity_embedding.vector는 vector(512) 고정이고 실제 차원은 dim 컬럼에 둔다. */
export const EMBEDDING_STORAGE_DIM = 512;

/**
 * 저장 차원보다 짧은 벡터는 뒤를 0으로 채운다 — 코사인 유사도는 패딩에 영향받지 않는다.
 * 얼굴(SFace)은 ML이 이미 채워 보내지만 신체 인코더(256차원)는 그대로 오므로 여기서 맞춘다.
 */
export function toStorageVector(v: number[], storageDim = EMBEDDING_STORAGE_DIM): number[] {
  if (v.length > storageDim) {
    throw new Error(`임베딩 차원 ${v.length}이 저장 차원 ${storageDim}을 넘습니다`);
  }
  return v.length === storageDim ? v : [...v, ...new Array<number>(storageDim - v.length).fill(0)];
}

export async function insertEmbedding(input: {
  id: string;
  identityId: string;
  assetId: string | null;
  kind: 'FACE' | 'BODY';
  modelName: string;
  modelVersion: string;
  dim: number;
  vector: number[];
  quality: number | null;
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO identity_embedding
      (id, identity_id, asset_id, kind, model_name, model_version, dim, vector, quality, created_at)
    VALUES (
      ${input.id}::uuid, ${input.identityId}::uuid,
      ${input.assetId}::uuid, ${input.kind}, ${input.modelName}, ${input.modelVersion},
      ${input.dim}, ${toVectorLiteral(toStorageVector(input.vector))}::vector, ${input.quality}, now()
    )`;
}

/** 자산을 다시 검사할 때 이전 임베딩을 지운다 — 같은 사진이 프로파일에 두 번 집계되지 않게 한다. */
export async function deleteEmbeddingsForAsset(assetId: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM identity_embedding WHERE asset_id = ${assetId}::uuid`;
}

export async function listEmbeddings(
  identityId: string,
  kind: 'FACE' | 'BODY',
): Promise<Array<{ id: string; assetId: string | null; vector: number[]; quality: number | null; modelName: string; modelVersion: string }>> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; asset_id: string | null; vector: string; dim: number; quality: string | null; model_name: string; model_version: string }>
  >`
    SELECT e.id, e.asset_id, e.vector::text AS vector, e.dim, e.quality::text AS quality,
           e.model_name, e.model_version
    FROM identity_embedding e
    JOIN identity_asset a ON a.id = e.asset_id
    WHERE e.identity_id = ${identityId}::uuid AND e.kind = ${kind} AND a.is_usable = true`;
  return rows.map((r) => ({
    id: r.id,
    assetId: r.asset_id,
    // 저장 패딩을 걷어내 원래 차원으로 돌려준다 — 신체 centroid 컬럼이 vector(256)이다.
    vector: (parseVectorLiteral(r.vector) ?? []).slice(0, r.dim),
    quality: r.quality === null ? null : Number(r.quality),
    modelName: r.model_name,
    modelVersion: r.model_version,
  }));
}

export async function setProfileCentroids(
  profileId: string,
  faceCentroid: number[] | null,
  bodyCentroid: number[] | null,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE identity_profile
    SET face_centroid = ${faceCentroid ? toVectorLiteral(faceCentroid) : null}::vector,
        body_centroid = ${bodyCentroid ? toVectorLiteral(bodyCentroid) : null}::vector
    WHERE id = ${profileId}::uuid`;
}

export async function getProfileCentroids(
  profileIds: string[],
): Promise<Array<{ id: string; identityId: string; faceCentroid: number[] | null; bodyCentroid: number[] | null }>> {
  if (profileIds.length === 0) return [];
  const rows = await prisma.$queryRaw<
    Array<{ id: string; identity_id: string; face: string | null; body: string | null }>
  >`
    SELECT id, identity_id, face_centroid::text AS face, body_centroid::text AS body
    FROM identity_profile
    WHERE id IN (${Prisma.join(profileIds.map((p) => Prisma.sql`${p}::uuid`))})`;
  return rows.map((r) => ({
    id: r.id,
    identityId: r.identity_id,
    faceCentroid: parseVectorLiteral(r.face),
    bodyCentroid: parseVectorLiteral(r.body),
  }));
}

export async function setSourceTrackCentroid(trackId: string, centroid: number[] | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE source_track SET face_centroid = ${centroid ? toVectorLiteral(centroid) : null}::vector
    WHERE id = ${trackId}::uuid`;
}

/** 코사인 유사도 (0..1로 클램프하지 않은 원값). ML 서비스와 동일 정의. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
