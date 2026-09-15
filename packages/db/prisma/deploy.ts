/**
 * `pnpm db:deploy` — 생체 벡터 암호화 이행을 포함한 마이그레이션 적용 (§16, ADR 0003).
 *
 * 20260915000100_encrypt_biometric_vectors 마이그레이션은 평문 pgvector 컬럼을 삭제한다. 암호화에는
 * 애플리케이션 키(BIOMETRIC_ENCRYPTION_KEY)가 필요해 SQL로 할 수 없으므로 순서를 이렇게 둔다.
 *
 *   1. 평문 컬럼이 남아 있으면 암호문 컬럼을 만들어 채우고, 행마다 복호화해 원본과 같은지 확인한다
 *   2. prisma migrate deploy — 마이그레이션은 평문만 남은 행을 발견하면 삭제 전에 멈춘다
 *   3. 이행을 했으면 VACUUM FULL로 테이블을 다시 써서, 삭제된 평문이 데이터 파일에 남지 않게 한다
 *
 * 새 DB이거나 이미 이행한 DB에서는 1·3을 건너뛰므로 여러 번 실행해도 안전하다.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertEncryptionConfig, decryptVector, encryptVector, type BiometricSlot } from '../src/biometric';

// api·worker와 같은 순서로 .env를 읽는다. 이미 있는 환경변수는 덮어쓰지 않는다.
for (const file of ['.env', '../../.env']) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) process.loadEnvFile(path);
}

const TARGETS: ReadonlyArray<{ table: string; plain: string; enc: string; slot: BiometricSlot }> = [
  { table: 'identity_embedding', plain: 'vector', enc: 'vector_enc', slot: 'identity_embedding.vector' },
  { table: 'identity_profile', plain: 'face_centroid', enc: 'face_centroid_enc', slot: 'identity_profile.face_centroid' },
  { table: 'identity_profile', plain: 'body_centroid', enc: 'body_centroid_enc', slot: 'identity_profile.body_centroid' },
  { table: 'source_track', plain: 'face_centroid', enc: 'face_centroid_enc', slot: 'source_track.face_centroid' },
];

const prisma = new PrismaClient();

/** pgvector 텍스트 표현('[0.1,0.2]') */
function parseVectorLiteral(s: string): number[] {
  return s.replace(/^\[|\]$/g, '').split(',').filter(Boolean).map(Number);
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}`;
  return Number(rows[0]?.n ?? 0) > 0;
}

/** 평문 컬럼이 하나라도 있었으면 true — 이행 대상 DB다 */
async function encryptPlaintextVectors(): Promise<boolean> {
  let found = false;
  for (const t of TARGETS) {
    if (!(await columnExists(t.table, t.plain))) continue;
    found = true;
    // 테이블·컬럼 이름은 위 상수에서만 온다
    await prisma.$executeRawUnsafe(`ALTER TABLE "${t.table}" ADD COLUMN IF NOT EXISTS "${t.enc}" BYTEA`);
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; plain: string }>>(
      `SELECT id::text AS id, "${t.plain}"::text AS plain FROM "${t.table}"
       WHERE "${t.plain}" IS NOT NULL AND "${t.enc}" IS NULL`,
    );
    for (const r of rows) {
      const vector = parseVectorLiteral(r.plain);
      const enc = encryptVector(vector, t.slot, r.id);
      // 평문 컬럼은 곧 삭제되므로 되돌려 읽어 확인한다. pgvector도 float4라 값이 정확히 같아야 한다.
      const back = decryptVector(enc, t.slot, r.id);
      if (back.length !== vector.length || back.some((v, i) => v !== Math.fround(vector[i]))) {
        throw new Error(`${t.table}.${t.plain} ${r.id}: 복호화 결과가 원본과 다릅니다 — 이행을 중단합니다`);
      }
      await prisma.$executeRawUnsafe(`UPDATE "${t.table}" SET "${t.enc}" = $1 WHERE id = $2::uuid`, enc, r.id);
    }
    console.log(`[biometric] ${t.table}.${t.plain} → ${t.enc}: ${rows.length}건 암호화`);
  }
  return found;
}

async function main() {
  assertEncryptionConfig();
  const migrating = await encryptPlaintextVectors();

  const deploy = spawnSync('prisma', ['migrate', 'deploy'], { stdio: 'inherit' });
  if (deploy.status !== 0) throw new Error(`prisma migrate deploy 실패 (exit ${deploy.status})`);

  if (migrating) {
    // DROP COLUMN은 기존 행의 평문 바이트를 데이터 파일에 그대로 둔다. 테이블을 새로 써서 지운다.
    // 이행 전 WAL·백업에 남은 평문은 여기서 지울 수 없다(ADR 0003).
    await prisma.$executeRawUnsafe('VACUUM FULL identity_embedding, identity_profile, source_track');
    console.log('[biometric] VACUUM FULL 완료 — 삭제된 평문 벡터를 데이터 파일에서 제거했습니다');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
