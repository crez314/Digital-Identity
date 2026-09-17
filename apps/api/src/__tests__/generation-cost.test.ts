import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrezError } from '@crez/shared';
import { GenerationService } from '../modules/project/generation.service';

/**
 * 1분 영상은 5초 구간 12개, 4분이면 48개다. 실행 버튼 한 번이 수십 건의 유료 생성을 제출하고,
 * 제출한 요청은 제공자가 취소를 거부할 수 있어 되돌릴 수 없다(§12.1).
 * 그래서 나가기 전에 견적을 내고 상한을 넘으면 아무것도 제출하지 않는다.
 */
const user = { id: 'u1', orgId: 'org1' } as never;

function segment(i: number, status = 'PENDING', attemptCount = 0) {
  return {
    id: `s${i}`, segmentIndex: i, startMs: i * 5000, endMs: (i + 1) * 5000,
    status, attemptCount,
  };
}

function setup(segments: ReturnType<typeof segment>[], opts: {
  preferredModel?: string;
  requiredMode?: string;
  models?: Array<{ code: string; costPerSecond: number; capabilities?: unknown }>;
} = {}) {
  const models = opts.models ?? [{ code: 'higgsfield-kling25-pro-i2v', costPerSecond: 0.25 }];
  const prisma = {
    project: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'p1', status: 'READY', projectType: 'MV',
        config: { preferredModel: opts.preferredModel, requiredMode: opts.requiredMode },
        cast: [{ identityId: 'i1', profileId: 'pr1', identity: { code: 'CRZ-A008' } }],
      }),
      update: vi.fn(),
    },
    segment: {
      findMany: vi.fn().mockResolvedValue(segments),
      update: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    // 지정 모델이 있으면 실제 서비스처럼 code로 걸러 낸다 — 없는 모델이면 빈 배열이 된다
    aiModel: {
      findMany: vi.fn().mockImplementation(({ where }: { where?: { code?: string } }) =>
        Promise.resolve(where?.code ? models.filter((m) => m.code === where.code) : models)),
    },
    generationJob: { aggregate: vi.fn().mockResolvedValue({ _max: { attempt: 0 } }) },
  };
  const audit = { record: vi.fn() };
  const queue = { add: vi.fn().mockResolvedValue('job1') };
  const events = { publish: vi.fn() };
  const rights = { enforce: vi.fn().mockResolvedValue(undefined) };
  const svc = new GenerationService(
    prisma as never, queue as never, audit as never, events as never, rights as never,
  );
  return { svc, prisma, audit, queue };
}

beforeEach(() => {
  delete process.env.GENERATION_COST_CONFIRM_THRESHOLD;
});

describe('실행 전 비용 견적 (§12.1)', () => {
  it('제출 없이 견적만 낸다', async () => {
    const { svc, queue } = setup([segment(0), segment(1)]);
    const e = await svc.estimate(user, 'p1', {});
    expect(e.max).toBe(2.5);           // 2건 × 5초 × 0.25
    expect(e.segmentCount).toBe(2);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('모델이 고정되지 않으면 후보 단가의 구간으로 답한다', async () => {
    const { svc } = setup([segment(0)], {
      models: [
        { code: 'a', costPerSecond: 0.25 },
        { code: 'b', costPerSecond: 0.4 },
      ],
    });
    const e = await svc.estimate(user, 'p1', {});
    expect(e.min).toBe(1.25);
    expect(e.max).toBe(2);
  });

  it('한도 안이면 그대로 제출한다', async () => {
    const { svc, queue } = setup([segment(0), segment(1)]);
    const res = await svc.generate(user, 'p1', {}, 't1');
    expect(res.submitted).toHaveLength(2);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('한도를 넘으면 한 건도 제출하지 않는다 — 부분 제출은 되돌릴 수 없다', async () => {
    // 12구간 × 1.25 = 15 > 기본 한도 10
    const { svc, queue } = setup(Array.from({ length: 12 }, (_, i) => segment(i)));
    await expect(svc.generate(user, 'p1', {}, 't1')).rejects.toThrow(CrezError);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('상한을 명시하면 그만큼 진행한다', async () => {
    const { svc, queue } = setup(Array.from({ length: 12 }, (_, i) => segment(i)));
    const res = await svc.generate(user, 'p1', { maxCost: 20 }, 't1');
    expect(res.submitted).toHaveLength(12);
    expect(queue.add).toHaveBeenCalledTimes(12);
  });

  it('명시한 상한도 넘으면 거절한다', async () => {
    const { svc } = setup(Array.from({ length: 12 }, (_, i) => segment(i)));
    await svc.generate(user, 'p1', { maxCost: 5 }, 't1').then(
      () => { throw new Error('거절해야 한다'); },
      (e: CrezError) => {
        expect(e.message).toContain('상한');
        expect((e.detail as { estimate: { max: number } }).estimate.max).toBe(15);
      },
    );
  });

  it('한도를 다 쓴 구간은 어차피 나가지 않으므로 견적에도 넣지 않는다', async () => {
    const { svc, queue } = setup([segment(0), segment(1, 'FAILED', 3)]);
    const res = await svc.generate(user, 'p1', {}, 't1');
    expect(res.estimatedCost.segmentCount).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('무료 모델만 쓰면 상한에 걸리지 않는다', async () => {
    const { svc } = setup(Array.from({ length: 40 }, (_, i) => segment(i)), {
      models: [{ code: 'mock-fast', costPerSecond: 0 }],
    });
    const res = await svc.generate(user, 'p1', {}, 't1');
    expect(res.estimatedCost.free).toBe(true);
    expect(res.submitted).toHaveLength(40);
  });

  it('한도는 환경변수로 조정한다', async () => {
    process.env.GENERATION_COST_CONFIRM_THRESHOLD = '100';
    const { svc } = setup(Array.from({ length: 12 }, (_, i) => segment(i)));
    await expect(svc.generate(user, 'p1', {}, 't1')).resolves.toBeTruthy();
  });

  it('견적과 상한을 감사에 남긴다 — 얼마를 승인했는지가 기록이어야 한다', async () => {
    const { svc, audit } = setup([segment(0)]);
    await svc.generate(user, 'p1', { maxCost: 3 }, 't1');
    const payload = audit.record.mock.calls[0][0].payload;
    expect(payload.estimatedCost.max).toBe(1.25);
    expect(payload.costCap).toBe(3);
  });
});

describe('지정 모델 우회 차단 (§12)', () => {
  it('없는 모델을 지정하면 견적 단계에서 거절한다 — 예전에는 견적 0으로 통과했다', async () => {
    // 2026-09-17 지적: 없는 modelHint를 주면 견적은 0이 되는데 워커는 다른 유료 모델을 골라 제출했다.
    const { svc, queue } = setup([segment(0)]);
    await expect(svc.generate(user, 'p1', { modelHint: 'does-not-exist' }, 't1')).rejects.toThrow(CrezError);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('거절 사유에 무엇을 확인해야 하는지 담는다', async () => {
    const { svc } = setup([segment(0)]);
    await svc.estimate(user, 'p1', { modelHint: 'does-not-exist' }).then(
      () => { throw new Error('거절해야 한다'); },
      (e: CrezError) => {
        expect(e.code).toBe('CREZ-GEN-001');
        expect(e.message).toContain('does-not-exist');
      },
    );
  });

  it('이 방식을 지원하는 활성 모델이 하나도 없으면 거절한다', async () => {
    const { svc } = setup([segment(0)], {
      requiredMode: 'v2v',
      models: [{ code: 'i2v-only', costPerSecond: 0.25, capabilities: { modes: ['i2v'] } }],
    });
    await expect(svc.generate(user, 'p1', {}, 't1')).rejects.toThrow(CrezError);
  });

  it('쓸 수 있는 모델을 지정하면 그 모델 단가로 견적을 낸다', async () => {
    const { svc } = setup([segment(0)], {
      models: [
        { code: 'cheap', costPerSecond: 0.1 },
        { code: 'expensive', costPerSecond: 0.4 },
      ],
    });
    const e = await svc.estimate(user, 'p1', { modelHint: 'expensive' });
    expect(e.max).toBe(2);
    expect(e.models).toEqual(['expensive']);
  });
});

describe('제공자 길이로 견적을 낸다 (§12.1)', () => {
  it('4초 구간 10개가 5초로 스냅되면 견적도 12.5다', async () => {
    const four = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`, segmentIndex: i, startMs: i * 4000, endMs: (i + 1) * 4000,
      status: 'PENDING', attemptCount: 0,
    }));
    const { svc } = setup(four as never, {
      models: [{ code: 'kling', costPerSecond: 0.25, capabilities: { durations: [5, 10] } }],
    });
    const e = await svc.estimate(user, 'p1', {});
    expect(e.max).toBe(12.5);
  });

  it('스냅 때문에 한도를 넘으면 제출하지 않는다', async () => {
    const four = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`, segmentIndex: i, startMs: i * 4000, endMs: (i + 1) * 4000,
      status: 'PENDING', attemptCount: 0,
    }));
    const { svc, queue } = setup(four as never, {
      models: [{ code: 'kling', costPerSecond: 0.25, capabilities: { durations: [5, 10] } }],
    });
    // 구간 길이로 계산하면 10이라 상한 12를 넘지 않지만, 실제 과금 길이로는 12.5라 넘는다
    await expect(svc.generate(user, 'p1', { maxCost: 12 }, 't1')).rejects.toThrow(CrezError);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
