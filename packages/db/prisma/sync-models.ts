/**
 * `pnpm --filter @crez/db sync:models` — Higgsfield 모델 목록만 DB에 반영한다.
 *
 * 전체 시드(seed.ts)는 지출 정책·QC 룰셋·샘플 인물까지 덮어쓴다. 모델을 추가·비활성화할 때마다 그걸
 * 돌리면 운영자가 바꿔 둔 한도가 초기값으로 돌아간다.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { syncHiggsfieldModels } from './higgsfield-models';

// api·worker와 같은 순서로 .env를 읽는다. 이미 있는 환경변수는 덮어쓰지 않는다.
for (const file of ['.env', '../../.env']) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) process.loadEnvFile(path);
}

const prisma = new PrismaClient();

syncHiggsfieldModels(prisma)
  .then((r) => console.log(`Higgsfield 모델 반영: 활성 ${r.active}개, 비활성 ${r.disabled}개`))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
