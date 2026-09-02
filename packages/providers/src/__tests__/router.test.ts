import { describe, expect, it } from 'vitest';
import { route } from '../router';
import { StaticQuotaView } from '../quota';
import type { ModelDescriptor } from '../types';

const base = (over: Partial<ModelDescriptor>): ModelDescriptor => ({
  id: over.code ?? 'x', code: over.code ?? 'x', provider: 'EXTERNAL_API', endpoint: null,
  capabilities: { maxDurationMs: 30000, maxPersons: 5, modes: ['pose-guided'], maxResolution: 1080 },
  costPerSecond: 0.1, status: 'ACTIVE',
  metrics: { identityScore: 0.8, motionScore: 0.8, qualityScore: 0.8, avgLatencyMs: 30000 },
  ...over,
});

const ctx = (over: Partial<Parameters<typeof route>[1]> = {}) => ({
  segmentDurationMs: 10000, castSize: 3, requiredMode: 'pose-guided', resolution: 1080,
  weights: { identity: 0.45, motion: 0.2, quality: 0.15, speed: 0.1, cost: 0.1 },
  weightsVersion: 'routing-v1', quota: new StaticQuotaView({}), ...over,
});

describe('Model Router (§12)', () => {
  it('능력 미달 모델은 점수 계산 대상이 아니다', () => {
    const models = [
      base({ code: 'short', capabilities: { maxDurationMs: 5000, maxPersons: 5, modes: ['pose-guided'], maxResolution: 1080 } }),
      base({ code: 'ok' }),
    ];
    const d = route(models, ctx());
    expect(d.model.code).toBe('ok');
    expect(d.trace.rejected.map((r) => r.code)).toContain('short');
  });

  it('인원 수 초과 모델을 거른다', () => {
    const models = [base({ code: 'small', capabilities: { maxDurationMs: 30000, maxPersons: 2, modes: ['pose-guided'], maxResolution: 1080 } })];
    expect(() => route(models, ctx({ castSize: 5 }))).toThrowError(/CREZ-GEN-001|조건을 만족/);
  });

  it('identity 지표가 높은 모델을 선호한다', () => {
    const models = [
      base({ code: 'cheap', costPerSecond: 0.01, metrics: { identityScore: 0.6, motionScore: 0.6, qualityScore: 0.6, avgLatencyMs: 10000 } }),
      base({ code: 'accurate', costPerSecond: 0.3, metrics: { identityScore: 0.95, motionScore: 0.9, qualityScore: 0.9, avgLatencyMs: 90000 } }),
    ];
    expect(route(models, ctx()).model.code).toBe('accurate');
  });

  it('재생성 4단계: 직전 모델을 제외하고 다른 모델로 라우팅한다 (§11)', () => {
    const a = base({ code: 'a' }); a.id = 'id-a';
    const b = base({ code: 'b' }); b.id = 'id-b';
    const d = route([a, b], ctx({ excludeModelIds: ['id-a'] }));
    expect(d.model.code).toBe('b');
  });

  it('quota가 소진된 모델은 후보에서 빠진다', () => {
    const models = [base({ code: 'busy' }), base({ code: 'free' })];
    const d = route(models, ctx({ quota: new StaticQuotaView({ busy: 0 }) }));
    expect(d.model.code).toBe('free');
  });

  it('선택 근거를 trace로 남긴다 (감사)', () => {
    const d = route([base({ code: 'a' })], ctx());
    expect(d.trace.chosen).toBe('a');
    expect(d.trace.scored[0].parts).toHaveProperty('identity');
    expect(d.trace.weightsVersion).toBe('routing-v1');
  });
});
