/**
 * 이미 만들어진 결과물에 QC만 다시 돌린다 — 생성 비용 없이 QC 규칙 변경을 검증할 때 쓴다.
 * 운영 경로가 아니다.
 *
 *   pnpm --filter @crez/worker exec tsx scripts/rerun-qc.ts <segmentId> <attempt>
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@crez/db';
import { JOB_NAME } from '@crez/contracts';
import { queues } from '../src/lib/queues';

async function main() {
  const [segmentId, attemptArg] = process.argv.slice(2);
  const job = await prisma.generationJob.findFirstOrThrow({
    where: { segmentId, attempt: Number(attemptArg) },
    include: { outputs: true, segment: { include: { project: true } } },
  });
  const output = job.outputs[0];
  await prisma.segment.update({ where: { id: segmentId }, data: { status: 'QC' } });
  const id = await queues.qc.add(JOB_NAME.QC_RUN, {
    traceId: randomUUID(),
    orgId: job.segment.project.orgId,
    projectId: job.segment.projectId,
    segmentId,
    outputId: output.id,
    attempt: job.attempt,
  });
  console.log('queued qc job', id.id, 'output', output.id);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
