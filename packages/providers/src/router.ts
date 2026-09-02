import { ErrorCode, CrezError } from '@crez/shared';
import type { GenerationRequest, ModelDescriptor } from './types';

/**
 * §12 Model Router — 2단계.
 * 1) 능력 하드 필터: 못 하는 모델은 점수 계산 대상이 아니다.
 * 2) 가중 점수: 가중치는 DB routing_ruleset에서 로드하여 주입받는다.
 * 선택 근거는 routing_trace에 전부 기록한다(사후 설명 가능성).
 */

export interface RoutingWeights {
  identity: number;
  motion: number;
  quality: number;
  speed: number;
  cost: number;
}

export interface QuotaView {
  /** 모델 code → 현재 여유 슬롯 수. 0 이하이면 제외 */
  available(modelCode: string): boolean;
  remaining(modelCode: string): number;
}

export interface RoutingContext {
  segmentDurationMs: number;
  castSize: number;
  requiredMode: string;
  resolution: number;
  weights: RoutingWeights;
  weightsVersion: string;
  quota: QuotaView;
  /** 재생성 4단계: 직전 시도에서 쓴 모델을 제외 (§11) */
  excludeModelIds?: string[];
  /** 운영자 modelHint */
  preferModelCode?: string;
}

export interface RoutingTrace {
  weightsVersion: string;
  requirements: Record<string, unknown>;
  rejected: Array<{ code: string; reason: string }>;
  scored: Array<{ code: string; score: number; parts: Record<string, number> }>;
  chosen: string;
  chosenReason: string;
  decidedAt: string;
}

export interface RoutingDecision {
  model: ModelDescriptor;
  trace: RoutingTrace;
}

const num = (v: number | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** 0..1로 정규화. 이미 0..1인 지표는 그대로, 지연/비용은 역수를 취해 넘긴다. */
function norm(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function route(
  models: ModelDescriptor[],
  ctx: RoutingContext,
): RoutingDecision {
  const rejected: RoutingTrace['rejected'] = [];
  const requirements = {
    durationMs: ctx.segmentDurationMs,
    persons: ctx.castSize,
    mode: ctx.requiredMode,
    resolution: ctx.resolution,
  };

  // 1단계 — 하드 필터
  const candidates = models.filter((m) => {
    if (m.status !== 'ACTIVE') { rejected.push({ code: m.code, reason: 'not ACTIVE' }); return false; }
    if (ctx.excludeModelIds?.includes(m.id)) { rejected.push({ code: m.code, reason: 'excluded (previous attempt)' }); return false; }
    const c = m.capabilities;
    if (c.maxDurationMs < ctx.segmentDurationMs) { rejected.push({ code: m.code, reason: `maxDurationMs ${c.maxDurationMs} < ${ctx.segmentDurationMs}` }); return false; }
    if (c.maxPersons < ctx.castSize) { rejected.push({ code: m.code, reason: `maxPersons ${c.maxPersons} < ${ctx.castSize}` }); return false; }
    if (!c.modes.includes(ctx.requiredMode as never)) { rejected.push({ code: m.code, reason: `mode ${ctx.requiredMode} unsupported` }); return false; }
    if (c.maxResolution < ctx.resolution) { rejected.push({ code: m.code, reason: `maxResolution ${c.maxResolution} < ${ctx.resolution}` }); return false; }
    if (!ctx.quota.available(m.code)) { rejected.push({ code: m.code, reason: 'quota exhausted' }); return false; }
    return true;
  });

  if (candidates.length === 0) {
    throw new CrezError(ErrorCode.GEN_NO_CAPABLE_MODEL, undefined, { requirements, rejected }, 422);
  }

  // 2단계 — 가중 점수
  const w = ctx.weights;
  const maxLatency = Math.max(...candidates.map((m) => num(m.metrics.avgLatencyMs, 60000)), 1);
  const maxCost = Math.max(...candidates.map((m) => m.costPerSecond || 0.0001), 0.0001);

  const scored = candidates.map((m) => {
    const parts = {
      identity: w.identity * norm(num(m.metrics.identityScore, 0.5)),
      motion: w.motion * norm(num(m.metrics.motionScore, 0.5)),
      quality: w.quality * norm(num(m.metrics.qualityScore, 0.5)),
      speed: w.speed * norm(1 - num(m.metrics.avgLatencyMs, 60000) / maxLatency),
      cost: w.cost * norm(1 - (m.costPerSecond || 0) / maxCost),
    };
    const score = Object.values(parts).reduce((s, v) => s + v, 0);
    return { model: m, code: m.code, score, parts };
  });

  scored.sort((a, b) => b.score - a.score);

  let chosen = scored[0];
  let chosenReason = 'highest weighted score';
  if (ctx.preferModelCode) {
    const hinted = scored.find((s) => s.code === ctx.preferModelCode);
    if (hinted) { chosen = hinted; chosenReason = `operator modelHint=${ctx.preferModelCode}`; }
    else rejected.push({ code: ctx.preferModelCode, reason: 'modelHint did not pass capability filter' });
  }

  return {
    model: chosen.model,
    trace: {
      weightsVersion: ctx.weightsVersion,
      requirements,
      rejected,
      scored: scored.map((s) => ({ code: s.code, score: Number(s.score.toFixed(5)), parts: s.parts })),
      chosen: chosen.code,
      chosenReason,
      decidedAt: new Date().toISOString(),
    },
  };
}
