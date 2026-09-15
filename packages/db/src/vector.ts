import { Prisma } from '@prisma/client';
import { BODY_EMBEDDING_DIM, FACE_EMBEDDING_DIM } from '@crez/shared';
import { prisma } from './client';
import { decryptVector, encryptVector } from './biometric';

/**
 * 생체 벡터(임베딩·centroid) 접근 헬퍼.
 * 벡터는 biometric.ts로 암호화해 bytea 컬럼에 저장한다(§16, ADR 0003). 스키마에는 Unsupported("bytea")로
 * 선언해 Prisma 기본 조회 결과에 암호문이 섞이지 않게 하고, 읽기/쓰기는 이 파일의 raw SQL로만 한다.
 */

/** §4.2 임베딩 저장 차원. 암호화 이전 vector(512) 컬럼의 규칙을 유지해 조회 결과가 달라지지 않게 한다(ADR 0002). */
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

/** 암호화 전에는 vector(512)·vector(256) 컬럼 타입이 차원을 강제했다. 암호문은 그러지 못하므로 여기서 막는다. */
function assertDim(v: number[], dim: number, what: string): void {
  if (v.length !== dim) throw new Error(`${what} 차원이 ${v.length}입니다 — ${dim}이어야 합니다`);
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
  const vectorEnc = encryptVector(toStorageVector(input.vector), 'identity_embedding.vector', input.id);
  await prisma.$executeRaw`
    INSERT INTO identity_embedding
      (id, identity_id, asset_id, kind, model_name, model_version, dim, vector_enc, quality, created_at)
    VALUES (
      ${input.id}::uuid, ${input.identityId}::uuid,
      ${input.assetId}::uuid, ${input.kind}, ${input.modelName}, ${input.modelVersion},
      ${input.dim}, ${vectorEnc}, ${input.quality}, now()
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
    Array<{ id: string; asset_id: string | null; vector_enc: Buffer; dim: number; quality: string | null; model_name: string; model_version: string }>
  >`
    SELECT e.id, e.asset_id, e.vector_enc, e.dim, e.quality::text AS quality,
           e.model_name, e.model_version
    FROM identity_embedding e
    JOIN identity_asset a ON a.id = e.asset_id
    WHERE e.identity_id = ${identityId}::uuid AND e.kind = ${kind} AND a.is_usable = true`;
  return rows.map((r) => ({
    id: r.id,
    assetId: r.asset_id,
    // 저장 패딩을 걷어내 원래 차원으로 돌려준다 — 신체 centroid는 256차원이다.
    vector: decryptVector(r.vector_enc, 'identity_embedding.vector', r.id).slice(0, r.dim),
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
  if (faceCentroid) assertDim(faceCentroid, FACE_EMBEDDING_DIM, 'face centroid');
  if (bodyCentroid) assertDim(bodyCentroid, BODY_EMBEDDING_DIM, 'body centroid');
  const faceEnc = faceCentroid ? encryptVector(faceCentroid, 'identity_profile.face_centroid', profileId) : null;
  const bodyEnc = bodyCentroid ? encryptVector(bodyCentroid, 'identity_profile.body_centroid', profileId) : null;
  await prisma.$executeRaw`
    UPDATE identity_profile
    SET face_centroid_enc = ${faceEnc}, body_centroid_enc = ${bodyEnc}
    WHERE id = ${profileId}::uuid`;
}

export async function getProfileCentroids(
  profileIds: string[],
): Promise<Array<{ id: string; identityId: string; faceCentroid: number[] | null; bodyCentroid: number[] | null }>> {
  if (profileIds.length === 0) return [];
  const rows = await prisma.$queryRaw<
    Array<{ id: string; identity_id: string; face: Buffer | null; body: Buffer | null }>
  >`
    SELECT id, identity_id, face_centroid_enc AS face, body_centroid_enc AS body
    FROM identity_profile
    WHERE id IN (${Prisma.join(profileIds.map((p) => Prisma.sql`${p}::uuid`))})`;
  return rows.map((r) => ({
    id: r.id,
    identityId: r.identity_id,
    faceCentroid: r.face ? decryptVector(r.face, 'identity_profile.face_centroid', r.id) : null,
    bodyCentroid: r.body ? decryptVector(r.body, 'identity_profile.body_centroid', r.id) : null,
  }));
}

export async function setSourceTrackCentroid(trackId: string, centroid: number[] | null): Promise<void> {
  if (centroid) assertDim(centroid, FACE_EMBEDDING_DIM, 'source track face centroid');
  const enc = centroid ? encryptVector(centroid, 'source_track.face_centroid', trackId) : null;
  await prisma.$executeRaw`
    UPDATE source_track SET face_centroid_enc = ${enc}
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
