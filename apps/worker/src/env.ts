import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * api의 ConfigModule(envFilePath: ['.env', '../../.env'])과 같은 순서로 .env를 읽는다.
 * turbo 2는 선언하지 않은 환경변수를 태스크에 넘기지 않으므로, `pnpm dev`로 띄우면 셸에서 export한 값이
 * 워커에 전달되지 않아 DATABASE_URL·S3_ENDPOINT 없이 돌게 된다.
 * 이미 있는 환경변수는 덮어쓰지 않으므로 컨테이너에서 주입한 값이 우선한다.
 *
 * 큐·스토리지 클라이언트가 import 시점에 환경변수를 읽으므로 main.ts에서 가장 먼저 import해야 한다.
 */
for (const file of ['.env', '../../.env']) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) process.loadEnvFile(path);
}
