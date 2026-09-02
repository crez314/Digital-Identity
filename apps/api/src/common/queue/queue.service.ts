import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE, QUEUE_POLICY, type QueueName } from '@crez/shared';

/**
 * §8 큐 제출. crez-api는 job을 제출만 하고 실행하지 않는다(§2.2).
 * 모든 payload는 traceId/projectId/segmentId/attempt를 포함한다.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection: IORedis;
  private readonly queues = new Map<QueueName, Queue>();

  constructor() {
    this.connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
  }

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async add<T extends object>(
    queueName: QueueName,
    jobName: string,
    payload: T,
    opts: JobsOptions = {},
  ): Promise<string> {
    const policy = QUEUE_POLICY[queueName];
    const job = await this.queue(queueName).add(jobName, payload, {
      attempts: policy.attempts,
      backoff: policy.backoffMs > 0 ? { type: 'exponential', delay: policy.backoffMs } : undefined,
      removeOnComplete: { age: 86400, count: 5000 },
      removeOnFail: { age: 604800 },
      ...opts,
    });
    return String(job.id);
  }

  /** 실행 중 job 취소 (§6.3 POST /projects/{id}/cancel, §14.1 consent 철회 시) */
  async cancelByProject(projectId: string): Promise<number> {
    let cancelled = 0;
    for (const name of Object.values(QUEUE) as QueueName[]) {
      const q = this.queue(name);
      const jobs = await q.getJobs(['waiting', 'delayed', 'active', 'paused']);
      for (const job of jobs) {
        if ((job.data as { projectId?: string })?.projectId === projectId) {
          await job.remove().catch(() => undefined);
          cancelled += 1;
        }
      }
    }
    return cancelled;
  }

  async counts(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const name of Object.values(QUEUE) as QueueName[]) {
      out[name] = await this.queue(name).getJobCounts();
    }
    return out;
  }

  async onModuleDestroy() {
    for (const q of this.queues.values()) await q.close().catch(() => undefined);
    await this.connection.quit().catch(() => undefined);
  }
}
