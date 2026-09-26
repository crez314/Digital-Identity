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

/** 라우터가 쓰는 하드 조건. 견적·제출 어디서 부르든 같은 기준이어야 한다. */
export interface CapabilityNeed {
  segmentDurationMs: number;
  castSize: number;
  requiredMode: string;
  resolution: number;
}

interface CapabilityLike {
  code: string;
  status?: string;
  capabilities: { maxDurationMs: number; maxPersons: number; modes: string[]; maxResolution: number };
}

/** 모델 하나가 조건에서 어긋난 항목들. 빈 배열이면 후보다. */
export function capabilityFailures(m: CapabilityLike, need: CapabilityNeed): string[] {
  const c = m.capabilities;
  const fails: string[] = [];
  if (m.status !== undefined && m.status !== 'ACTIVE') fails.push('not ACTIVE');
  if (c.maxDurationMs < need.segmentDurationMs) fails.push(`maxDurationMs ${c.maxDurationMs} < ${need.segmentDurationMs}`);
  if (c.maxPersons < need.castSize) fails.push(`maxPersons ${c.maxPersons} < ${need.castSize}`);
  if (!c.modes.includes(need.requiredMode)) fails.push(`mode ${need.requiredMode} unsupported`);
  if (c.maxResolution < need.resolution) fails.push(`maxResolution ${c.maxResolution} < ${need.resolution}`);
  return fails;
}

/**
 * 조건을 만족하는 모델이 하나도 없으면 무엇을 바꾸면 되는지까지 담아 던진다.
 * "조건을 만족하는 모델 없음"만 보면 해상도 한 칸 때문인지 인원 때문인지 알 수 없다.
 */
export function noCapableModelError(
  need: CapabilityNeed, failures: Map<string, string[]>, rejected: Array<{ code: string; reason: string }>,
): CrezError {
  const nearest = [...failures.entries()].filter(([, f]) => f.length === 1).slice(0, 3);
  const want = `${need.segmentDurationMs / 1000}초 · ${need.castSize}명 · ${need.requiredMode} · ${need.resolution}p`;
  const hint = nearest.length > 0
    ? ` 한 가지만 어긋난 모델: ${nearest.map(([code, f]) => `${code}(${f[0]})`).join(', ')} — 그 조건을 맞추면 됩니다`
    : '';
  return new CrezError(
    ErrorCode.GEN_NO_CAPABLE_MODEL,
    `조건(${want})을 모두 만족하는 활성 모델이 없습니다.${hint}`,
    { requirements: {
      durationMs: need.segmentDurationMs, persons: need.castSize, mode: need.requiredMode, resolution: need.resolution,
    }, rejected }, 422,
  );
}

/**
 * 제출 전에 "쓸 수 있는 모델이 있는가"만 본다 — 견적 단계에서 부른다.
 * 여기서 걸러내지 않으면 시도 횟수와 예약만 쓰고 워커에서 실패한다.
 */
export function assertCapableModelExists(models: CapabilityLike[], need: CapabilityNeed): void {
  const failures = new Map<string, string[]>();
  const rejected: Array<{ code: string; reason: string }> = [];
  for (const m of models) {
    const fails = capabilityFailures(m, need);
    if (fails.length === 0) return;
    failures.set(m.code, fails);
    rejected.push({ code: m.code, reason: fails.join(', ') });
  }
  throw noCapableModelError(need, failures, rejected);
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

  // 1단계 — 하드 필터.
  // 어긋난 조건을 처음 하나에서 멈추지 않고 전부 모은다 — "무엇을 바꾸면 되는지"를 알려면
  // 한 가지만 어긋난 모델을 찾아낼 수 있어야 한다.
  const failures = new Map<string, string[]>();
  const candidates = models.filter((m) => {
    const fails = capabilityFailures(m, ctx);
    if (ctx.excludeModelIds?.includes(m.id)) fails.push('excluded (previous attempt)');
    if (!ctx.quota.available(m.code)) fails.push('quota exhausted');
    if (fails.length === 0) return true;
    failures.set(m.code, fails);
    rejected.push({ code: m.code, reason: fails.join(', ') });
    return false;
  });

  if (candidates.length === 0) throw noCapableModelError(ctx, failures, rejected);

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
