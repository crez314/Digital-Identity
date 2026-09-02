import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE } from '@crez/shared';

export const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const make = (name: string) => new Queue(name, { connection });

export const queues = {
  ingest: make(QUEUE.INGEST),
  analysis: make(QUEUE.ANALYSIS),
  generation: make(QUEUE.GENERATION),
  qc: make(QUEUE.QC),
  regeneration: make(QUEUE.REGENERATION),
  media: make(QUEUE.MEDIA),
};

export async function closeQueues(): Promise<void> {
  await Promise.all(Object.values(queues).map((q) => q.close().catch(() => undefined)));
  await connection.quit().catch(() => undefined);
}
