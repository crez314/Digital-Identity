import IORedis from 'ioredis';
import type { ProjectEvent } from '@crez/contracts';

/** 워커 → API SSE 브릿지 (§6.3) */
const CHANNEL = 'crez:project-events';
let publisher: IORedis | null = null;

function conn(): IORedis {
  publisher ??= new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  return publisher;
}

export async function emit(event: Omit<ProjectEvent, 'at'> & { at?: string }): Promise<void> {
  await conn().publish(CHANNEL, JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() }));
}

export async function closeEvents(): Promise<void> {
  await publisher?.quit().catch(() => undefined);
  publisher = null;
}
