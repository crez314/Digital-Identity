import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@crez/db';
import { logger } from '@crez/shared';
import { PRISMA } from '../../common/prisma.module';

/**
 * §12: m.metrics는 고정값이 아니라 과거 QC 결과에서 역산한 실측치다.
 * 모델별 평균 Identity Score, 재생성 발생률, 실패율을 롤링 윈도우로 집계해 갱신한다.
 */
@Injectable()
export class ModelMetricsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async refreshAll(windowDays = 30) {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      model_id: string; identity_score: number | null; avg_latency_ms: number | null;
      failure_rate: number | null; regen_rate: number | null; sample_size: number;
    }>>(
      `SELECT j.model_id,
              avg(q.overall_score)::float                                          AS identity_score,
              avg(EXTRACT(EPOCH FROM (j.finished_at - j.started_at)) * 1000)::float AS avg_latency_ms,
              (count(*) FILTER (WHERE j.status = 'FAILED'))::float
                / NULLIF(count(*), 0)                                              AS failure_rate,
              (count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM regeneration_task t WHERE t.segment_id = j.segment_id
              )))::float / NULLIF(count(*), 0)                                     AS regen_rate,
              count(*)::int                                                        AS sample_size
       FROM generation_job j
       LEFT JOIN generation_output o ON o.job_id = j.id
       LEFT JOIN qc_run q ON q.output_id = o.id
       WHERE j.created_at > now() - ($1 || ' days')::interval
       GROUP BY j.model_id`,
      String(windowDays),
    );

    const updated: string[] = [];
    for (const r of rows) {
      const model = await this.prisma.aiModel.findUnique({ where: { id: r.model_id } });
      if (!model) continue;
      const prior = (model.metrics ?? {}) as Record<string, number>;
      // 표본이 적으면 기존 값을 유지한다 — 한두 건으로 라우팅이 뒤집히면 안 된다.
      const blend = (next: number | null, key: string) =>
        next === null || r.sample_size < 5 ? (prior[key] ?? next ?? 0.5) : next;

      await this.prisma.aiModel.update({
        where: { id: model.id },
        data: {
          metrics: {
            ...prior,
            identityScore: blend(r.identity_score, 'identityScore'),
            avgLatencyMs: blend(r.avg_latency_ms, 'avgLatencyMs'),
            failureRate: blend(r.failure_rate, 'failureRate'),
            regenRate: blend(r.regen_rate, 'regenRate'),
            sampleSize: r.sample_size,
            refreshedAt: new Date().toISOString(),
          } as never,
        },
      });
      updated.push(model.code);
    }
    logger.info({ updated, windowDays }, 'model metrics refreshed');
    return { updated, windowDays };
  }
}
