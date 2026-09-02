import type { Job } from 'bullmq';
import { prisma } from '@crez/db';
import { classifyOutcome, decideStrategy, type PriorAttempt } from '@crez/engine';
import { CrezError, ErrorCode, childLogger } from '@crez/shared';
import { JOB_NAME, type RegenerationJobPayload } from '@crez/contracts';
import { emit } from '../lib/events';
import { queues } from '../lib/queues';

/**
 * regeneration 큐 (§8): 전략 결정 후 generation 큐 재투입.
 * 이 큐 자체는 재시도하지 않는다 — 전략 자체가 재시도이기 때문이다.
 *
 * §11 전략 사다리는 @crez/engine이 결정하고, 여기서는 이력 기록과 큐 재투입만 한다.
 */
export async function regenerationProcessor(job: Job): Promise<unknown> {
  if (job.name !== JOB_NAME.REGENERATION_PLAN) throw new Error(`unknown regeneration job: ${job.name}`);
  const data = job.data as RegenerationJobPayload & { regenerationTaskId?: string };
  const log = childLogger({ traceId: data.traceId, segmentId: data.segmentId });

  const segment = await prisma.segment.findUnique({
    where: { id: data.segmentId },
    include: {
      regenTasks: { orderBy: { createdAt: 'asc' } },
      jobs: { orderBy: { attempt: 'desc' }, take: 1 },
    },
  });
  if (!segment) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, '세그먼트 없음', data, 404);

  const qcRun = await prisma.qcRun.findUnique({
    where: { id: data.qcRunId }, include: { findings: true },
  });
  if (!qcRun) throw new CrezError(ErrorCode.PRJ_NOT_FOUND, 'QC run 없음', data, 404);

  // ── 직전 재생성의 결과를 먼저 분류해 이력에 남긴다 (§11 데이터 축적) ──
  const openTask = segment.regenTasks.find((t) => t.outcome === null && t.resultJobId !== null);
  if (openTask) {
    const outcome = classifyOutcome(
      openTask.scoreBefore ? Number(openTask.scoreBefore) : null,
      qcRun.overallScore ? Number(qcRun.overallScore) : null,
    );
    await prisma.regenerationTask.update({
      where: { id: openTask.id }, data: { outcome, scoreAfter: qcRun.overallScore },
    });
    segment.regenTasks = segment.regenTasks.map((t) =>
      t.id === openTask.id ? { ...t, outcome, scoreAfter: qcRun.overallScore } : t,
    );
    log.info({ taskId: openTask.id, outcome }, 'previous regeneration outcome classified');
  }

  const priorAttempts: PriorAttempt[] = segment.regenTasks
    .filter((t) => t.outcome !== null || t.resultJobId !== null)
    .map((t) => ({
      strategy: t.strategy as unknown as PriorAttempt['strategy'],
      outcome: t.outcome as PriorAttempt['outcome'],
      scoreAfter: t.scoreAfter ? Number(t.scoreAfter) : null,
    }));

  const perIdentity = (qcRun.perIdentity ?? {}) as Record<string, { score?: number }>;
  const rulesetRow = await prisma.qcRuleset.findUnique({ where: { version: qcRun.rulesetVersion } });
  const perIdentityMin = Number((rulesetRow?.thresholds as { perIdentityMin?: number })?.perIdentityMin ?? 0.85);
  const failingIdentityIds = Object.entries(perIdentity)
    .filter(([, v]) => (v.score ?? 1) < perIdentityMin)
    .map(([k]) => k);

  const lastJob = segment.jobs[0];
  const decision = decideStrategy({
    findings: qcRun.findings.map((f) => ({
      identityId: f.identityId, findingType: f.findingType as never, severity: f.severity as never,
      startMs: f.startMs, endMs: f.endMs, confidence: Number(f.confidence), evidence: {},
    })),
    priorAttempts,
    attemptCount: segment.attemptCount,
    segmentDurationMs: segment.endMs - segment.startMs,
    lastModelId: lastJob?.modelId ?? null,
    lastConditioningStrength: Number((lastJob?.params as { conditioningStrength?: number })?.conditioningStrength ?? 0.6),
    failingIdentityIds,
  });

  // ── 5단계: MANUAL_REVIEW 승격 ──
  if (decision.escalate) {
    await prisma.$transaction([
      prisma.segment.update({ where: { id: segment.id }, data: { status: 'MANUAL_REVIEW' } }),
      prisma.regenerationTask.create({
        data: {
          segmentId: segment.id, sourceQcRunId: qcRun.id,
          strategy: decision.strategy as never, outcome: 'ESCALATED',
          scoreBefore: qcRun.overallScore,
        },
      }),
    ]);
    await emit({
      type: 'SEGMENT_STATUS', projectId: data.projectId, segmentId: segment.id,
      payload: { status: 'MANUAL_REVIEW', reason: decision.strategy.rationale, code: ErrorCode.QC_REGEN_LIMIT },
      traceId: data.traceId,
    });
    log.warn({ rationale: decision.strategy.rationale }, 'escalated to MANUAL_REVIEW');
    return { escalated: true, rationale: decision.strategy.rationale };
  }

  // ── 3단계 SEGMENT_SPLIT: 세그먼트를 실제로 쪼갠다 ──
  if (decision.strategy.kind === 'SEGMENT_SPLIT') {
    const children = await splitSegment(segment.id, decision.strategy.params as { maxChildDurationMs?: number });
    if (children > 1) {
      log.info({ children }, 'segment split into children');
    }
  }

  const task = await prisma.regenerationTask.create({
    data: {
      segmentId: segment.id, sourceQcRunId: qcRun.id,
      strategy: decision.strategy as never, scoreBefore: qcRun.overallScore,
    },
  });

  const attempt = segment.attemptCount + 1;
  await prisma.segment.update({
    where: { id: segment.id }, data: { status: 'GENERATING', attemptCount: attempt },
  });

  await queues.generation.add(JOB_NAME.GENERATION_SUBMIT, {
    traceId: data.traceId, orgId: data.orgId, projectId: data.projectId,
    segmentId: segment.id, attempt,
    strategy: decision.strategy,
    regenerationTaskId: task.id,
    scoreBefore: qcRun.overallScore ? Number(qcRun.overallScore) : null,
  });

  await emit({
    type: 'SEGMENT_STATUS', projectId: data.projectId, segmentId: segment.id,
    payload: {
      status: 'GENERATING', attempt,
      strategyStep: decision.strategy.step, strategyKind: decision.strategy.kind,
      rationale: decision.strategy.rationale,
    },
    traceId: data.traceId,
  });

  log.info({ step: decision.strategy.step, kind: decision.strategy.kind }, 'regeneration strategy applied');
  return { taskId: task.id, strategy: decision.strategy, attempt };
}

/**
 * 세그먼트를 maxChildDurationMs 이하 조각으로 나누는 경계를 계산한다.
 * 마지막 조각이 극단적으로 짧아지지 않도록 균등 분할한다.
 */
export function splitBounds(startMs: number, endMs: number, maxChildDurationMs?: number): number[] {
  const maxChild = Math.max(1000, maxChildDurationMs ?? 4000);
  const duration = endMs - startMs;
  if (duration <= maxChild) return [startMs, endMs];

  const parts = Math.ceil(duration / maxChild);
  const step = Math.ceil(duration / parts);
  const bounds: number[] = [];
  for (let ms = startMs; ms < endMs; ms += step) bounds.push(ms);
  bounds.push(endMs);
  return bounds;
}

/**
 * §11 3단계 — 문제 구간을 더 짧게 쪼개 개별 생성.
 * 기존 세그먼트를 자식 세그먼트로 대체한다. 뒤따르는 세그먼트 인덱스는 밀어낸다.
 */
async function splitSegment(segmentId: string, params: { maxChildDurationMs?: number }): Promise<number> {
  const segment = await prisma.segment.findUniqueOrThrow({ where: { id: segmentId } });
  const bounds = splitBounds(segment.startMs, segment.endMs, params.maxChildDurationMs);
  const parts = bounds.length - 1;
  if (parts <= 1) return 1;

  await prisma.$transaction(async (tx) => {
    // 뒤 세그먼트 인덱스를 확보한다
    const shift = parts - 1;
    const following = await tx.segment.findMany({
      where: { projectId: segment.projectId, segmentIndex: { gt: segment.segmentIndex } },
      orderBy: { segmentIndex: 'desc' },
    });
    for (const s of following) {
      await tx.segment.update({ where: { id: s.id }, data: { segmentIndex: s.segmentIndex + shift } });
    }

    // 첫 조각은 기존 레코드를 재사용해 attempt 이력을 유지한다
    await tx.segment.update({
      where: { id: segment.id }, data: { startMs: bounds[0], endMs: bounds[1] },
    });
    for (let i = 1; i < bounds.length - 1; i++) {
      await tx.segment.create({
        data: {
          projectId: segment.projectId, sceneId: segment.sceneId,
          segmentIndex: segment.segmentIndex + i,
          startMs: bounds[i], endMs: bounds[i + 1],
          status: 'PENDING', attemptCount: 0,
        },
      });
    }
  });

  return parts;
}
