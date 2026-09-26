import { lockOrganizationSpend, prisma } from '@crez/db';
import { JOB_NAME } from '@crez/contracts';
import { queues } from './queues';
import { emit } from './events';

type Context = { traceId: string; orgId: string; projectId: string; segmentId: string };
type Result = {
  storageKey: string; durationMs: number; fps: number; width: number; height: number; costAmount: number;
};

/** 결과·성공 상태·정산을 함께 확정하고, QC 전달은 내구성 있는 미완료 표시로 복구한다. */
export async function finalizeGeneration(jobId: string, data: Context, result?: Result) {
  const finalized = await prisma.$transaction(async (tx) => {
    await lockOrganizationSpend(tx, data.orgId);
    await tx.$executeRaw`SELECT id FROM generation_job WHERE id = ${jobId}::uuid FOR UPDATE`;
    const job = await tx.generationJob.findUnique({ where: { id: jobId }, include: { model: true } });
    if (!job || ['FAILED', 'CANCELLED'].includes(job.status)) return null;
    let output = await tx.generationOutput.findUnique({ where: { jobId } });
    if (!output) {
      if (!result) throw new Error(`Missing generation output: ${jobId}`);
      output = await tx.generationOutput.create({ data: {
        jobId, storageKey: result.storageKey, durationMs: result.durationMs,
        fps: result.fps, width: result.width, height: result.height,
      } });
    }
    if (job.status !== 'SUCCEEDED') {
      await tx.generationJob.update({ where: { id: jobId }, data: {
        status: 'SUCCEEDED', finishedAt: new Date(), ...(result ? { costAmount: result.costAmount } : {}),
      } });
      await tx.segment.update({ where: { id: data.segmentId }, data: { status: 'QC' } });
    }
    const free = job.model.code.startsWith('mock')
      || (job.model.capabilities as { billable?: boolean } | null)?.billable === false;
    // 이전 버전이 결과만 저장하고 죽은 경우 비용을 모르면 예약 추정액을 보존한다.
    await tx.spendEntry.updateMany({
      where: { orgId: data.orgId, segmentId: job.segmentId, attempt: job.attempt, status: { not: 'RELEASED' } },
      data: { status: 'SETTLED', ...(free ? { amountCredits: 0 } : result ? { amountCredits: result.costAmount } : {}) },
    });
    return { output, attempt: job.attempt };
  });
  if (!finalized) return { skipped: 'job ended' };
  const { output, attempt } = finalized;
  if (!output.qcQueuedAt) {
    await queues.qc.add(JOB_NAME.QC_RUN, { ...data, outputId: output.id, attempt }, {
      // ACK만 유실되어도 재전달은 같은 큐 작업을 가리킨다. 복구 중 삭제되지 않도록 보존한다.
      jobId: `qc-${output.id}`, removeOnComplete: false, removeOnFail: false,
    });
    await prisma.generationOutput.update({ where: { id: output.id }, data: { qcQueuedAt: new Date() } });
    await emit({ type: 'SEGMENT_STATUS', ...data, payload: { status: 'QC', attempt } });
  }
  return { state: 'SUCCEEDED', outputId: output.id };
}
