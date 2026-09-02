import { Worker, type Processor } from 'bullmq';
import { prisma } from '@crez/db';
import { QUEUE, QUEUE_POLICY, CrezError, logger, type QueueName } from '@crez/shared';
import { connection, closeQueues } from './lib/queues';
import { closeEvents } from './lib/events';
import { ingestProcessor } from './processors/ingest';
import { analysisProcessor } from './processors/analysis';
import { generationProcessor, reconcileSubmittedJobs } from './processors/generation';
import { qcProcessor } from './processors/qc';
import { regenerationProcessor } from './processors/regeneration';
import { mediaProcessor } from './processors/media';

/**
 * §2.1 crez-worker — BullMQ 워커 (프로세스 분리 실행).
 * WORKER_QUEUES 환경변수로 이 프로세스가 담당할 큐를 고른다.
 * 예: WORKER_QUEUES=generation,qc  (GPU 노드는 analysis/qc만 띄우는 식으로 분리 배치)
 */
const PROCESSORS: Record<QueueName, Processor> = {
  [QUEUE.INGEST]: ingestProcessor,
  [QUEUE.ANALYSIS]: analysisProcessor,
  [QUEUE.GENERATION]: generationProcessor,
  [QUEUE.QC]: qcProcessor,
  [QUEUE.REGENERATION]: regenerationProcessor,
  [QUEUE.MEDIA]: mediaProcessor,
};

const selected = (process.env.WORKER_QUEUES ?? Object.values(QUEUE).join(','))
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is QueueName => s in PROCESSORS);

const workers: Worker[] = [];

function start() {
  for (const name of selected) {
    const policy = QUEUE_POLICY[name];
    const worker = new Worker(name, PROCESSORS[name], {
      connection,
      concurrency: Number(process.env[`WORKER_CONCURRENCY_${name.toUpperCase()}`] ?? policy.concurrency),
    });

    worker.on('completed', (job, result) => {
      logger.info(
        { queue: name, jobId: job.id, jobName: job.name, traceId: (job.data as { traceId?: string })?.traceId, result },
        'job completed',
      );
    });

    worker.on('failed', (job, err) => {
      const code = err instanceof CrezError ? err.code : null;
      logger.error(
        {
          queue: name, jobId: job?.id, jobName: job?.name,
          traceId: (job?.data as { traceId?: string })?.traceId,
          attemptsMade: job?.attemptsMade, code, err: err.message,
        },
        'job failed',
      );
    });

    workers.push(worker);
    logger.info({ queue: name, concurrency: policy.concurrency }, 'worker started');
  }

  // §8 reconciler — SUBMITTED 상태 job을 주기적으로 스캔해 폴링 유실을 복구한다.
  if (selected.includes(QUEUE.GENERATION)) {
    const intervalMs = Number(process.env.GEN_RECONCILE_INTERVAL_MS ?? 60000);
    const timer = setInterval(() => {
      reconcileSubmittedJobs().catch((e) => logger.error({ err: String(e) }, 'reconcile failed'));
    }, intervalMs);
    timer.unref();
    logger.info({ intervalMs }, 'generation reconciler scheduled');
  }
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down workers');
  await Promise.all(workers.map((w) => w.close().catch(() => undefined)));
  await closeQueues();
  await closeEvents();
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start();
