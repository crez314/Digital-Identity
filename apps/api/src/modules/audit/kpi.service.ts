import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@crez/db';
import { PRISMA } from '../../common/prisma.module';

/**
 * §20 KPI 및 측정 방법.
 * 모든 KPI는 DB 쿼리로 자동 산출한다 — 수기 집계 지표는 결국 측정되지 않는다.
 */
@Injectable()
export class KpiService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async compute(orgId: string, projectId?: string) {
    const scope = projectId ? { projectId } : {};

    const [singleMedian, multiMin, swapRate, regenSuccess, costPerMinute, manualTime] = await Promise.all([
      this.singlePersonMedian(orgId, projectId),
      this.multiPersonMin(orgId, projectId),
      this.identitySwapRate(orgId, projectId),
      this.regenerationSuccessRate(orgId, projectId),
      this.costPerMinute(orgId, projectId),
      this.humanEditingTime(orgId, projectId),
    ]);

    return {
      scope,
      singlePersonIdentityScore: { value: singleMedian, target: 0.9, method: '1인 영상 QC 종합 점수 중앙값' },
      multiPersonIdentityScore: { value: multiMin, target: 0.85, method: '5인 영상 캐스트별 점수의 최솟값 평균' },
      identitySwapRate: { value: swapRate, target: 0.03, method: 'SWAP finding 세그먼트 / 전체 세그먼트' },
      regenerationSuccessRate: { value: regenSuccess, target: 0.7, method: '3회 이내 재생성으로 합격한 비율' },
      generationCostPerMinute: { value: costPerMinute, target: null, method: 'cost_amount 합계 / 마스터 길이(분)' },
      humanEditingTimeMinutesPerVideoMinute: { value: manualTime, target: 10, method: 'MANUAL_REVIEW 처리 시간 / 영상 길이' },
      note: 'QC Detection Recall / False Positive Rate는 라벨링 검증셋(Phase 2 산출물) 대비로 산출한다.',
    };
  }

  private async singlePersonMedian(orgId: string, projectId?: string): Promise<number | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ median: number | null }>>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.overall_score)::float AS median
       FROM qc_run q
       JOIN generation_output o ON o.id = q.output_id
       JOIN generation_job j ON j.id = o.job_id
       JOIN segment s ON s.id = j.segment_id
       JOIN project p ON p.id = s.project_id
       WHERE p.org_id = $1::uuid
         AND ($2::uuid IS NULL OR p.id = $2::uuid)
         AND q.overall_score IS NOT NULL
         AND (SELECT count(*) FROM project_cast pc WHERE pc.project_id = p.id) = 1`,
      orgId, projectId ?? null,
    );
    return rows[0]?.median ?? null;
  }

  private async multiPersonMin(orgId: string, projectId?: string): Promise<number | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ avg_min: number | null }>>(
      `SELECT avg(q.overall_score)::float AS avg_min
       FROM qc_run q
       JOIN generation_output o ON o.id = q.output_id
       JOIN generation_job j ON j.id = o.job_id
       JOIN segment s ON s.id = j.segment_id
       JOIN project p ON p.id = s.project_id
       WHERE p.org_id = $1::uuid
         AND ($2::uuid IS NULL OR p.id = $2::uuid)
         AND q.overall_score IS NOT NULL
         AND (SELECT count(*) FROM project_cast pc WHERE pc.project_id = p.id) > 1`,
      orgId, projectId ?? null,
    );
    return rows[0]?.avg_min ?? null;
  }

  private async identitySwapRate(orgId: string, projectId?: string): Promise<number | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ rate: number | null }>>(
      `WITH seg AS (
         SELECT s.id,
                EXISTS (
                  SELECT 1 FROM generation_job j
                  JOIN generation_output o ON o.job_id = j.id
                  JOIN qc_run q ON q.output_id = o.id
                  JOIN qc_finding f ON f.qc_run_id = q.id
                  WHERE j.segment_id = s.id AND f.finding_type = 'IDENTITY_SWAP'
                ) AS has_swap
         FROM segment s
         JOIN project p ON p.id = s.project_id
         WHERE p.org_id = $1::uuid AND ($2::uuid IS NULL OR p.id = $2::uuid)
       )
       SELECT CASE WHEN count(*) = 0 THEN NULL
                   ELSE (count(*) FILTER (WHERE has_swap))::float / count(*) END AS rate
       FROM seg`,
      orgId, projectId ?? null,
    );
    return rows[0]?.rate ?? null;
  }

  private async regenerationSuccessRate(orgId: string, projectId?: string): Promise<number | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ rate: number | null }>>(
      `WITH regen_segments AS (
         SELECT s.id, s.status, s.attempt_count
         FROM segment s
         JOIN project p ON p.id = s.project_id
         WHERE p.org_id = $1::uuid AND ($2::uuid IS NULL OR p.id = $2::uuid)
           AND EXISTS (SELECT 1 FROM regeneration_task t WHERE t.segment_id = s.id)
       )
       SELECT CASE WHEN count(*) = 0 THEN NULL
                   ELSE (count(*) FILTER (WHERE status = 'PASSED' AND attempt_count <= 3))::float / count(*) END AS rate
       FROM regen_segments`,
      orgId, projectId ?? null,
    );
    return rows[0]?.rate ?? null;
  }

  private async costPerMinute(orgId: string, projectId?: string): Promise<number | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ cost_per_min: number | null }>>(
      `SELECT CASE WHEN sum(m.duration_ms) IS NULL OR sum(m.duration_ms) = 0 THEN NULL
                   ELSE (SELECT coalesce(sum(j.cost_amount), 0) FROM generation_job j
                         JOIN segment s ON s.id = j.segment_id
                         WHERE s.project_id = ANY(array_agg(m.project_id)))::float
                        / (sum(m.duration_ms)::float / 60000.0) END AS cost_per_min
       FROM master_video m
       JOIN project p ON p.id = m.project_id
       WHERE p.org_id = $1::uuid AND ($2::uuid IS NULL OR p.id = $2::uuid)`,
      orgId, projectId ?? null,
    );
    return rows[0]?.cost_per_min ?? null;
  }

  /** MANUAL_REVIEW 진입 → 승인/재생성까지의 경과 시간 합계 (감사 로그 기준) */
  private async humanEditingTime(orgId: string, projectId?: string): Promise<number | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ minutes: number | null }>>(
      `SELECT sum(EXTRACT(EPOCH FROM (a.occurred_at - s.updated_at)))::float / 60.0 AS minutes
       FROM audit_log a
       JOIN segment s ON s.id = (a.payload->>'segmentId')::uuid
       JOIN project p ON p.id = s.project_id
       WHERE a.org_id = $1::uuid AND a.action = 'QC_MANUAL_ACCEPT'
         AND ($2::uuid IS NULL OR p.id = $2::uuid)`,
      orgId, projectId ?? null,
    );
    return rows[0]?.minutes ?? null;
  }
}
