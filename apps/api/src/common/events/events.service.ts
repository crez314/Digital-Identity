import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import IORedis from 'ioredis';
import { Observable, Subject, filter, map } from 'rxjs';
import type { ProjectEvent } from '@crez/contracts';
import { logger } from '@crez/shared';

const CHANNEL = 'crez:project-events';

/**
 * §6.3 GET /projects/{id}/events — SSE로 진행률·상태 변경을 스트리밍한다.
 * 워커는 별도 프로세스이므로 Redis pub/sub을 경유해 API 인스턴스로 전달한다.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly subject = new Subject<ProjectEvent>();
  private publisher!: IORedis;
  private subscriber!: IORedis;

  onModuleInit() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.publisher = new IORedis(url, { maxRetriesPerRequest: null });
    this.subscriber = new IORedis(url, { maxRetriesPerRequest: null });
    this.subscriber.subscribe(CHANNEL).catch((e) => logger.error({ err: String(e) }, 'sse subscribe failed'));
    this.subscriber.on('message', (_ch, raw) => {
      try { this.subject.next(JSON.parse(raw) as ProjectEvent); }
      catch (e) { logger.warn({ err: String(e) }, 'bad project event payload'); }
    });
  }

  async publish(event: ProjectEvent): Promise<void> {
    await this.publisher.publish(CHANNEL, JSON.stringify(event));
  }

  stream(projectId: string): Observable<{ data: ProjectEvent }> {
    return this.subject.asObservable().pipe(
      filter((e) => e.projectId === projectId),
      map((data) => ({ data })),
    );
  }

  async onModuleDestroy() {
    await this.subscriber?.quit().catch(() => undefined);
    await this.publisher?.quit().catch(() => undefined);
  }
}
