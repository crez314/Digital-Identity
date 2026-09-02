import type { FindingType, RegenStrategy } from '@crez/contracts';
import { MAX_REGEN, NO_CHANGE_ESCALATION_LIMIT } from '@crez/shared';
import type { DetectedFinding } from './rules';

/**
 * §11 재생성 전략 사다리.
 *
 * 재생성은 무작위 재시도가 아니라 오류 유형에 대응하는 결정론적 전략이다.
 * 단계가 올라갈수록 비용과 결과 변동이 커진다.
 *
 * 무한 루프 방지 (§5.1):
 *  - 재생성 시도마다 전략이 달라져야 한다 (동일 파라미터 재시도 금지)
 *  - outcome이 연속 2회 NO_CHANGE면 즉시 MANUAL_REVIEW로 승격
 *  - MAX_REGEN 초과 시 MANUAL_REVIEW
 */

export interface PriorAttempt {
  strategy: Pick<RegenStrategy, 'step' | 'kind'> & { params?: Record<string, unknown> };
  outcome: 'IMPROVED' | 'NO_CHANGE' | 'WORSE' | 'ESCALATED' | null;
  scoreAfter: number | null;
}

export interface StrategyContext {
  findings: DetectedFinding[];
  priorAttempts: PriorAttempt[];
  /** 현재까지 생성 시도 횟수 (segment.attempt_count) */
  attemptCount: number;
  segmentDurationMs: number;
  /** 직전 시도에 사용한 모델 id — 4단계에서 제외 대상 */
  lastModelId: string | null;
  /** 이전 conditioning 강도 */
  lastConditioningStrength: number;
  /** 하한 미달 인물 (§10.3) */
  failingIdentityIds: string[];
}

export interface StrategyDecision {
  escalate: boolean;
  strategy: RegenStrategy;
}

const dominant = (findings: DetectedFinding[]): FindingType | null => {
  if (findings.length === 0) return null;
  const rank: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  const byWeight = new Map<string, number>();
  for (const f of findings) {
    const dur = Math.max(f.endMs - f.startMs, 1);
    byWeight.set(f.findingType, (byWeight.get(f.findingType) ?? 0) + dur * rank[f.severity] * f.confidence);
  }
  return [...byWeight.entries()].sort((a, b) => b[1] - a[1])[0][0] as FindingType;
};

const totalSpanMs = (findings: DetectedFinding[], type: FindingType) =>
  findings.filter((f) => f.findingType === type).reduce((s, f) => s + (f.endMs - f.startMs), 0);

/**
 * 오류 유형 → 최소 시작 단계.
 * 사다리는 항상 아래에서 올라가지만, 오류 유형에 따라 무의미한 하위 단계를 건너뛴다.
 */
function baseStepFor(ctx: StrategyContext): number {
  const type = dominant(ctx.findings);
  if (!type) return 1;
  switch (type) {
    case 'IDENTITY_DRIFT': {
      // 장시간 드리프트는 conditioning 상향으로 해결되지 않는다 → 3단계(재분할)부터
      const longDrift = totalSpanMs(ctx.findings, 'IDENTITY_DRIFT') > ctx.segmentDurationMs * 0.4;
      return longDrift ? 3 : 1;
    }
    case 'IDENTITY_BLEND':
      return 2; // 레퍼런스 세트 교체가 1차 처방
    case 'IDENTITY_SWAP':
      return 3; // 구간을 쪼개 인물 혼동 여지를 줄인다
    case 'TRACK_LOST':
    case 'TEMPORAL_FLICKER':
      return 1;
    default:
      return 1;
  }
}

/** 반복 발생하는 SWAP/BLEND는 모델 자체의 한계 → 4단계 재라우팅 (§11) */
function repeatedIdentityConfusion(ctx: StrategyContext): boolean {
  const confusing = ctx.findings.some((f) => f.findingType === 'IDENTITY_SWAP' || f.findingType === 'IDENTITY_BLEND');
  const triedLower = ctx.priorAttempts.filter((p) => p.strategy.step <= 3).length;
  return confusing && triedLower >= 2;
}

export function decideStrategy(ctx: StrategyContext): StrategyDecision {
  const escalated = (rationale: string): StrategyDecision => ({
    escalate: true,
    strategy: { step: 5, kind: 'MANUAL_REVIEW', params: {}, rationale },
  });

  // 무한 루프 방지 — 연속 NO_CHANGE
  const recent = ctx.priorAttempts.slice(-NO_CHANGE_ESCALATION_LIMIT);
  if (
    recent.length >= NO_CHANGE_ESCALATION_LIMIT &&
    recent.every((p) => p.outcome === 'NO_CHANGE')
  ) {
    return escalated(`연속 ${NO_CHANGE_ESCALATION_LIMIT}회 NO_CHANGE — 전략 사다리로 개선되지 않음 (§5.1)`);
  }

  if (ctx.priorAttempts.length >= MAX_REGEN || ctx.attemptCount >= MAX_REGEN) {
    return escalated(`재생성 한도 ${MAX_REGEN}회 소진 (§5.1, CREZ-QC-002)`);
  }

  const usedSteps = new Set(ctx.priorAttempts.map((p) => p.strategy.step));
  let step = Math.max(baseStepFor(ctx), 1);
  if (repeatedIdentityConfusion(ctx)) step = Math.max(step, 4);
  // 동일 전략 재시도 금지 — 이미 쓴 단계는 건너뛴다
  while (usedSteps.has(step) && step < 5) step += 1;
  if (step >= 5) return escalated('사다리 1–4단계를 모두 소진');

  const dom = dominant(ctx.findings);
  // 구간 단위 오류가 없는데 종합 점수만 미달인 경우가 있다. 그때 'UNKNOWN'이라고
  // 적으면 이력을 나중에 읽는 사람이 원인을 오해한다.
  const cause = dom ?? '구간 오류 없이 종합 점수 미달';
  const targets = ctx.failingIdentityIds;

  switch (step) {
    case 1:
      return {
        escalate: false,
        strategy: {
          step: 1,
          kind: 'CONDITIONING_BOOST',
          params: {
            conditioningStrength: Number(Math.min(1, ctx.lastConditioningStrength + 0.15).toFixed(2)),
            changeSeed: true,
            targetIdentityIds: targets,
          },
          rationale: `${cause} (경미) — identity conditioning 상향 + seed 변경`,
        },
      };
    case 2:
      return {
        escalate: false,
        strategy: {
          step: 2,
          kind: 'REFERENCE_SWAP',
          params: {
            // 문제 구간의 포즈·조명과 유사한 자산을 우선 선택한다
            preferSlots: ['LEFT_45', 'RIGHT_45', 'FRONT'],
            excludePreviouslyUsed: true,
            targetIdentityIds: targets,
            problemSpans: ctx.findings.map((f) => ({ startMs: f.startMs, endMs: f.endMs, type: f.findingType })),
          },
          rationale: `${cause} — 레퍼런스 세트를 문제 구간의 포즈·조명에 맞춰 교체`,
        },
      };
    case 3: {
      const spans = ctx.findings.map((f) => [f.startMs, f.endMs] as const);
      return {
        escalate: false,
        strategy: {
          step: 3,
          kind: 'SEGMENT_SPLIT',
          params: {
            splitAroundMs: spans.map(([s, e]) => ({ startMs: s, endMs: e })),
            maxChildDurationMs: Math.max(2000, Math.floor(ctx.segmentDurationMs / 3)),
            targetIdentityIds: targets,
          },
          rationale: `${cause} — 문제 구간을 더 짧게 쪼개 개별 생성`,
        },
      };
    }
    default:
      return {
        escalate: false,
        strategy: {
          step: 4,
          kind: 'MODEL_REROUTE',
          params: {
            excludeModelIds: ctx.lastModelId ? [ctx.lastModelId] : [],
            targetIdentityIds: targets,
          },
          rationale: `${cause} 반복 발생 — 다른 생성 모델로 라우팅`,
        },
      };
  }
}

/** 재생성 결과 판정 (§11 이력 축적). 개선 폭이 미미하면 NO_CHANGE로 본다. */
export function classifyOutcome(before: number | null, after: number | null, epsilon = 0.01) {
  if (before === null || after === null) return 'NO_CHANGE' as const;
  const delta = after - before;
  if (delta > epsilon) return 'IMPROVED' as const;
  if (delta < -epsilon) return 'WORSE' as const;
  return 'NO_CHANGE' as const;
}
