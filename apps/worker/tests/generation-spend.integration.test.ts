import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  prisma, readSpendCredits, readSpendLedger, setSourceTrackCentroid, setProfileCentroids,
} from '@crez/db';
import { providerRegistry } from '@crez/providers';
import { JOB_NAME } from '@crez/contracts';
import { CrezError, ErrorCode } from '@crez/shared';
import { GenerationService } from '../../api/src/modules/project/generation.service';
import { SpendService } from '../../api/src/modules/spend/spend.service';
import { ProjectService } from '../../api/src/modules/project/project.service';
import { QcService } from '../../api/src/modules/qc/qc.service';
import { generationProcessor, reconcileSubmittedJobs } from '../src/processors/generation';
import { retryAfterContentPolicy } from '../src/lib/policy-retry';
import { finalizeGeneration } from '../src/lib/generation-finalize';

const f = vi.hoisted(() => ({
  qcAdd: vi.fn(), generationAdd: vi.fn(), generationGetJob: vi.fn(), emit: vi.fn(), audit: vi.fn(),
}));
vi.mock('../src/lib/queues', () => ({
  queues: { qc: { add: f.qcAdd }, generation: { add: f.generationAdd, getJob: f.generationGetJob } },
}));
vi.mock('../src/lib/events', () => ({ emit: f.emit }));
vi.mock('../src/lib/audit', () => ({ audit: f.audit }));

// 외부 생성 제공자는 대체하고 PostgreSQL 잠금/트랜잭션과 Redis 중복 제거는 실제로 검증한다.
const orgIds: string[] = [];
const modelIds: string[] = [];
const queue = { add: vi.fn(), cancelByProject: vi.fn().mockResolvedValue(0) };
const audit = { record: vi.fn() };
const events = { publish: vi.fn() };
const rights = { enforce: vi.fn() };
const spend = new SpendService(prisma, audit as never);
const generation = new GenerationService(prisma, queue as never, audit as never, events as never, rights as never, spend);
let redis: IORedis;
let qcQueue: Queue;

async function fixture(budget = 10_000) {
  const org = await prisma.organization.create({ data: { name: 'PR1 integration' } });
  orgIds.push(org.id);
  const user = await prisma.appUser.create({ data: {
    orgId: org.id, email: `${randomUUID()}@example.test`, displayName: 'Test', role: 'OWNER',
  } });
  await prisma.spendPolicy.create({ data: { orgId: org.id, monthlyBudgetKrw: budget, creditUnitPriceKrw: 1000 } });
  const model = await prisma.aiModel.create({ data: {
    code: `review-${randomUUID()}`, provider: 'EXTERNAL_API', costPerSecond: 1.2,
    capabilities: { billable: true, modes: ['i2v'], maxDurationMs: 10000, maxPersons: 2, maxResolution: 1080, durations: [5, 10] },
  } });
  modelIds.push(model.id);
  const identity = await prisma.identity.create({ data: { orgId: org.id, code: 'TEST', displayName: 'Test', status: 'ACTIVE' } });
  const profile = await prisma.identityProfile.create({ data: { identityId: identity.id, version: 1, status: 'ACTIVE' } });
  async function project() {
    const project = await prisma.project.create({ data: {
      orgId: org.id, createdBy: user.id, title: 'Review test', status: 'READY', projectType: 'MV',
      config: { requiredMode: 'i2v', preferredModel: model.code },
      cast: { create: { identityId: identity.id, profileId: profile.id, slotIndex: 0 } },
    } });
    const segment = await prisma.segment.create({ data: {
      projectId: project.id, segmentIndex: 0, startMs: 0, endMs: 5000, status: 'PENDING', attemptCount: 0,
    } });
    return { project, segment };
  }
  return { org, user: user as never, model, identity, profile, project };
}

async function paidJob(fx: Awaited<ReturnType<typeof fixture>>, p: Awaited<ReturnType<typeof fx.project>>) {
  const job = await prisma.generationJob.create({ data: {
    segmentId: p.segment.id, attempt: 1, modelId: fx.model.id, routingTrace: {}, params: { traceId: 'trace-1' },
    status: 'RUNNING', providerJobId: `provider-${randomUUID()}`, startedAt: new Date(Date.now() - 300000),
  } });
  await prisma.segment.update({ where: { id: p.segment.id }, data: { status: 'GENERATING', attemptCount: 1 } });
  await prisma.spendEntry.create({ data: { orgId: fx.org.id, projectId: p.project.id,
    segmentId: p.segment.id, attempt: 1, amountCredits: 6, status: 'SUBMITTED' } });
  const data = { orgId: fx.org.id, projectId: p.project.id, segmentId: p.segment.id, traceId: 'trace-1' };
  return { job, data };
}
const result = { storageKey: 'test/result.mp4', durationMs: 5000, fps: 30, width: 1280, height: 720, costAmount: 6 };

describe.skipIf(!process.env.TEST_DATABASE_URL)('실제 DB/큐: 지출 예약과 결과 인계', () => {
  beforeAll(() => {
    redis = new IORedis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    qcQueue = new Queue(`review-qc-${randomUUID()}`, { connection: redis });
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    queue.add.mockReset().mockResolvedValue('queue-id');
    f.qcAdd.mockReset().mockImplementation((...args) => qcQueue.add(...args as Parameters<Queue['add']>));
    f.generationAdd.mockReset().mockResolvedValue({ id: 'queue-id' });
    // 기본은 "큐에 남은 작업 없음" — 살아있음을 보려는 테스트에서만 채운다
    f.generationGetJob.mockReset().mockResolvedValue(null);
    f.emit.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await prisma.project.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.identity.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.appUser.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.spendEntry.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.aiModel.deleteMany({ where: { id: { in: modelIds } } });
    await qcQueue.obliterate({ force: true });
    await qcQueue.close(); await redis.quit(); await prisma.$disconnect();
  });

  it('동시 API 요청은 워커 시작 전에도 한도를 두 번 통과하지 못한다', async () => {
    const fx = await fixture();
    const [a, b] = await Promise.all([fx.project(), fx.project()]);
    const outcomes = await Promise.allSettled([
      generation.generate(fx.user, a.project.id, { maxCost: 6 }, 'run-a'),
      generation.generate(fx.user, b.project.id, { maxCost: 6 }, 'run-b'),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await readSpendCredits(prisma, fx.org.id)).toBe(6);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(await prisma.generationJob.count({ where: { segment: { project: { orgId: fx.org.id } } } })).toBe(0);
  });

  it('같은 구간에 대한 동시 요청은 한 번만 예약한다', async () => {
    const fx = await fixture(300000); const p = await fx.project();
    const outcomes = await Promise.allSettled([1, 2].map((n) => generation.generate(fx.user, p.project.id, {}, `run-${n}`)));
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await readSpendCredits(prisma, fx.org.id)).toBe(6);
    expect((await prisma.segment.findUniqueOrThrow({ where: { id: p.segment.id } })).attemptCount).toBe(1);
  });

  it('큐 전송 실패는 예약을 보존하고 reconciler가 다시 전달한다', async () => {
    const fx = await fixture(); const p = await fx.project();
    queue.add.mockRejectedValueOnce(new Error('redis unavailable'));
    await generation.generate(fx.user, p.project.id, {}, 'recover');
    expect(await readSpendCredits(prisma, fx.org.id)).toBe(6);
    await reconcileSubmittedJobs();
    expect(f.generationAdd).toHaveBeenCalledWith(JOB_NAME.GENERATION_SUBMIT,
      expect.objectContaining({ segmentId: p.segment.id }), expect.objectContaining({ jobId: `submit-${p.segment.id}-1` }));
    const entry = await prisma.spendEntry.findUniqueOrThrow({ where: { segmentId_attempt: { segmentId: p.segment.id, attempt: 1 } } });
    expect(entry.dispatchedAt).not.toBeNull();
  });

  it('무료 모델은 유료 단가 설정 없이도 실행한다', async () => {
    const fx = await fixture(0); const p = await fx.project();
    await prisma.aiModel.update({ where: { id: fx.model.id }, data: {
      capabilities: { ...fx.model.capabilities as object, billable: false },
    } });
    await prisma.spendPolicy.update({ where: { orgId: fx.org.id }, data: { creditUnitPriceKrw: null } });
    expect((await generation.generate(fx.user, p.project.id, {}, 'free')).estimatedCost.max).toBe(0);
    expect(await readSpendCredits(prisma, fx.org.id)).toBe(0);
  });

  it('프로젝트 삭제 후에도 확정 사용액이 남아 다음 생성을 막는다', async () => {
    const fx = await fixture(); const p = await fx.project();
    const { job, data } = await paidJob(fx, p);
    await finalizeGeneration(job.id, data, result);
    await prisma.project.delete({ where: { id: p.project.id } });
    expect(await readSpendCredits(prisma, fx.org.id)).toBe(6);
    const next = await fx.project();
    await expect(generation.generate(fx.user, next.project.id, {}, 'next')).rejects.toThrow(/월 한도/);
  });

  it('수동 재생성은 한도를 초과하면 작업/큐를 만들기 전에 거절한다', async () => {
    const fx = await fixture(6000); const p = await fx.project();
    const { job, data } = await paidJob(fx, p);
    await finalizeGeneration(job.id, data, result);
    const output = await prisma.generationOutput.findUniqueOrThrow({ where: { jobId: job.id } });
    await prisma.qcRun.create({ data: { outputId: output.id, rulesetVersion: 'test', status: 'FAILED' } });
    await prisma.segment.update({ where: { id: p.segment.id }, data: { status: 'MANUAL_REVIEW' } });
    const qc = new QcService(prisma, queue as never, audit as never, events as never, {} as never, {} as never, generation);
    await expect(qc.regenerate(fx.user, p.segment.id, { strategyOverride: { step: 1, kind: 'CONDITIONING_BOOST' } }, 'manual'))
      .rejects.toThrow(/월 한도/);
    expect(await prisma.regenerationTask.count({ where: { segmentId: p.segment.id } })).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('자동/수동 재생성이 워커에 바로 도착해도 제공자 제출 전에 한도를 검사한다', async () => {
    const fx = await fixture(0); const p = await fx.project();
    await prisma.segment.update({ where: { id: p.segment.id }, data: { status: 'GENERATING', attemptCount: 2 } });
    const provider = { code: 'fake-paid', planImages: () => ({ images: [], droppedReferenceIds: [] }),
      estimateCost: () => 6, submit: vi.fn() };
    vi.spyOn(providerRegistry, 'resolve').mockReturnValue(provider as never);
    const response = await generationProcessor({ name: JOB_NAME.GENERATION_SUBMIT,
      data: { orgId: fx.org.id, projectId: p.project.id, segmentId: p.segment.id, attempt: 2, traceId: 'auto-regen' },
    } as never);
    expect(response).toMatchObject({ failed: true });
    expect(provider.submit).not.toHaveBeenCalled();
    expect(await prisma.generationJob.count({ where: { segmentId: p.segment.id } })).toBe(0);
    expect((await prisma.segment.findUniqueOrThrow({ where: { id: p.segment.id } })).status).toBe('FAILED');
  });

  it('공개 주소 장애는 제공자 제출 없이 예약·횟수를 되돌리고 복구 후 다시 생성할 수 있다', async () => {
    const fx = await fixture(6000); const p = await fx.project();
    await generation.generate(fx.user, p.project.id, {}, 'dead-tunnel');
    const provider = {
      code: 'fake-paid',
      planImages: () => ({ images: [{ url: 'https://expired.trycloudflare.com/private/a?signature=secret' }], droppedReferenceIds: [] }),
      estimateCost: () => 6, submit: vi.fn().mockResolvedValue({ providerJobId: 'after-repair' }),
    };
    vi.spyOn(providerRegistry, 'resolve').mockReturnValue(provider as never);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const data = { orgId: fx.org.id, projectId: p.project.id, segmentId: p.segment.id, attempt: 1, traceId: 'dead-tunnel' };
    expect(await generationProcessor({ name: JOB_NAME.GENERATION_SUBMIT, data } as never))
      .toMatchObject({ failed: true, code: 'CREZ-GEN-002' });
    expect(provider.submit).not.toHaveBeenCalled();
    expect(await prisma.generationJob.count({ where: { segmentId: p.segment.id } })).toBe(0);
    expect(await readSpendCredits(prisma, fx.org.id)).toBe(0);
    expect(await prisma.spendEntry.findUniqueOrThrow({
      where: { segmentId_attempt: { segmentId: p.segment.id, attempt: 1 } },
    })).toMatchObject({ status: 'RELEASED' });
    expect(await prisma.segment.findUniqueOrThrow({ where: { id: p.segment.id } }))
      .toMatchObject({ status: 'FAILED', attemptCount: 0 });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: p.project.id } })).toMatchObject({ status: 'READY' });
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ERROR', payload: expect.objectContaining({ segmentStatus: 'FAILED', detail: expect.objectContaining({ sent: false }) }),
    }));

    fetch.mockResolvedValue(new Response(null, { status: 403 }));
    const retry = await generation.generate(fx.user, p.project.id, {}, 'repaired');
    await generationProcessor({ name: JOB_NAME.GENERATION_SUBMIT,
      data: { ...data, attempt: retry.submitted[0].attempt, traceId: 'repaired' },
    } as never);
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(await readSpendCredits(prisma, fx.org.id)).toBe(6);
  });

  it('이미 예약한 요청은 자기 비용을 이중 합산하지 않고 딱 한 번 제출한다', async () => {
    const fx = await fixture(6000); const p = await fx.project();
    await generation.generate(fx.user, p.project.id, {}, 'one-submit');
    const provider = { code: 'fake-paid', planImages: () => ({ images: [], droppedReferenceIds: [] }),
      estimateCost: () => 6, submit: vi.fn().mockResolvedValue({ providerJobId: 'accepted-once' }) };
    vi.spyOn(providerRegistry, 'resolve').mockReturnValue(provider as never);
    const job = { name: JOB_NAME.GENERATION_SUBMIT, data: {
      orgId: fx.org.id, projectId: p.project.id, segmentId: p.segment.id, attempt: 1, traceId: 'one-submit',
    } };
    await Promise.all([generationProcessor(job as never), generationProcessor(job as never)]);
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(await readSpendCredits(prisma, fx.org.id)).toBe(6);
  });

  it('취소된 예약을 해제하고 이전 큐 작업이 늦게 도착해도 다시 제출하지 않는다', async () => {
    const fx = await fixture(6000); const p = await fx.project();
    await generation.generate(fx.user, p.project.id, {}, 'cancelled');
    await generation.cancel(fx.user, p.project.id, 'cancel');
    expect(await readSpendCredits(prisma, fx.org.id)).toBe(0);
    const next = await generation.generate(fx.user, p.project.id, {}, 'next');
    expect(next.submitted[0].attempt).toBe(2);
    const provider = { submit: vi.fn() };
    vi.spyOn(providerRegistry, 'resolve').mockReturnValue(provider as never);
    const response = await generationProcessor({ name: JOB_NAME.GENERATION_SUBMIT,
      data: { orgId: fx.org.id, projectId: p.project.id, segmentId: p.segment.id, attempt: 1, traceId: 'cancelled' },
    } as never);
    expect(response).toEqual({ skipped: 'RELEASED' });
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('제출되지 않은 채 오래 남은 예약은 해제되어 한도가 풀린다', async () => {
    // 큐가 작업을 잃어버리면 예약만 남는다. 예약은 월이 바뀌어도 계속 합산되므로,
    // 청소하지 않으면 그 조직의 한도가 영구히 잠긴다.
    const fx = await fixture(6000); const p = await fx.project();
    await prisma.spendEntry.create({ data: {
      orgId: fx.org.id, projectId: p.project.id, segmentId: p.segment.id, attempt: 9,
      amountCredits: 6, status: 'RESERVED', createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    } });
    expect((await readSpendLedger(prisma, fx.org.id)).net).toBe(6);
    await expect(generation.generate(fx.user, p.project.id, {}, 'locked')).rejects.toThrow(/월 한도/);

    await reconcileSubmittedJobs();

    expect((await readSpendLedger(prisma, fx.org.id)).net).toBe(0);
    const entry = await prisma.spendEntry.findFirstOrThrow({ where: { segmentId: p.segment.id, attempt: 9 } });
    expect(entry.status).toBe('RELEASED');
    await expect(generation.generate(fx.user, p.project.id, {}, 'unlocked')).resolves.toBeTruthy();
  });

  it('큐에 아직 남아 있는 제출 작업의 예약은 오래돼도 해제하지 않는다', async () => {
    // 큐에서 실행되기 전의 작업은 generationJob 행이 없다. DB만 보면 '고아'로 오인해
    // 살아 있는 실행의 예약을 풀어 버리고, 이어지는 제출은 RELEASED로 조용히 끝난다.
    const fx = await fixture(6000); const p = await fx.project();
    await prisma.spendEntry.create({ data: {
      orgId: fx.org.id, projectId: p.project.id, segmentId: p.segment.id, attempt: 9,
      amountCredits: 6, status: 'RESERVED', createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    } });
    f.generationGetJob.mockImplementation((jobId: string) =>
      Promise.resolve(jobId === `submit-${p.segment.id}-9`
        ? { getState: () => Promise.resolve('delayed') }
        : null));

    await reconcileSubmittedJobs();

    const entry = await prisma.spendEntry.findFirstOrThrow({ where: { segmentId: p.segment.id, attempt: 9 } });
    expect(entry.status).toBe('RESERVED');
    expect(f.generationGetJob).toHaveBeenCalledWith(`submit-${p.segment.id}-9`);
  });

  it('고아 예약을 풀 때 구간도 함께 되돌린다 — 잠김이 돈에서 프로젝트로 옮겨가면 안 된다', async () => {
    const fx = await fixture(6000); const p = await fx.project();
    await prisma.segment.update({
      where: { id: p.segment.id }, data: { status: 'GENERATING', attemptCount: 1 },
    });
    await prisma.spendEntry.create({ data: {
      orgId: fx.org.id, projectId: p.project.id, segmentId: p.segment.id, attempt: 1,
      amountCredits: 6, status: 'RESERVED', createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    } });

    await reconcileSubmittedJobs();

    const segment = await prisma.segment.findUniqueOrThrow({ where: { id: p.segment.id } });
    expect(segment.status).toBe('PENDING');   // 다시 실행할 수 있다
    expect(segment.attemptCount).toBe(0);     // 제출된 적이 없으므로 시도도 되돌린다
    expect((await readSpendLedger(prisma, fx.org.id)).net).toBe(0);
  });

  it('제출 결과를 기록하지 못해 멈춘 작업을 종료 상태로 내린다', async () => {
    // 제공자는 접수했는데 그 직후 DB 쓰기가 실패하면 QUEUED·접수번호 없음으로 남는다.
    // 재시도는 멱등성 가드에 걸려 '정상 완료'로 끝나므로 아무도 줍지 못했다.
    const fx = await fixture(6000); const p = await fx.project();
    const job = await prisma.generationJob.create({ data: {
      segmentId: p.segment.id, attempt: 1, modelId: fx.model.id, routingTrace: {}, params: { traceId: 'stuck' },
      status: 'QUEUED', providerJobId: null, startedAt: new Date(Date.now() - 30 * 60 * 1000),
    } });
    await prisma.segment.update({ where: { id: p.segment.id }, data: { status: 'GENERATING', attemptCount: 1 } });
    await prisma.spendEntry.create({ data: { orgId: fx.org.id, projectId: p.project.id,
      segmentId: p.segment.id, attempt: 1, amountCredits: 6, status: 'SUBMITTED' } });

    await reconcileSubmittedJobs();

    const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('FAILED');
    expect(String(JSON.stringify(after.errorDetail))).toContain('제출 결과를 기록하지 못했습니다');
    // 접수 여부를 모르므로 과금은 그대로 둔다 — 과소 집계는 한도를 무력화한다
    expect((await readSpendLedger(prisma, fx.org.id)).net).toBe(6);
  });

  it('결과를 끝내 가져오지 못하면 구간이 GENERATING에 갇히지 않는다', async () => {
    const fx = await fixture(6000); const p = await fx.project();
    const { job, data } = await paidJob(fx, p);
    const provider = { code: 'fake-paid',
      poll: vi.fn().mockResolvedValue({ state: 'SUCCEEDED', progress: 1 }),
      fetchResult: vi.fn().mockRejectedValue(new Error('storage unreachable')) };
    vi.spyOn(providerRegistry, 'resolve').mockReturnValue(provider as never);
    const pollJob = { name: JOB_NAME.GENERATION_POLL, data: {
      ...data, generationJobId: job.id, providerJobId: job.providerJobId, pollCount: 0,
    // 실제 큐가 만드는 형태: attempts를 지정하지 않으면 BullMQ가 0을 박는다.
    // 첫 실패(재시도 남음)에는 결과를 버리지 않고 큐 재시도에 맡겨야 한다.
    }, attemptsMade: 0, opts: {} };
    await expect(generationProcessor(pollJob as never)).rejects.toThrow('storage unreachable');
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('RUNNING');

    // 마지막 시도(기본 3회)에서야 종료 상태로 내린다
    const lastTry = { ...pollJob, attemptsMade: 2 };
    const res = await generationProcessor(lastTry as never);

    expect(res).toMatchObject({ failed: true });
    const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('FAILED');
    expect((await prisma.segment.findUniqueOrThrow({ where: { id: p.segment.id } })).status)
      .not.toBe('GENERATING');
  });

  it('제공자가 거절한 제출은 실지출에서 빠지고 실패 포함 총량에만 남는다', async () => {
    // 콘텐츠 정책 거부·크레딧 부족·모델 차단은 제공자가 받아들이지 않은 것이라 돈이 나가지 않는다.
    // 이것까지 실지출로 세면 실제 지출이 0원인데 그 달 생성이 전면 차단된다.
    const fx = await fixture(6000); const p = await fx.project();
    await generation.generate(fx.user, p.project.id, {}, 'rejected');
    const provider = { code: 'fake-paid', planImages: () => ({ images: [], droppedReferenceIds: [] }),
      estimateCost: () => 6,
      submit: vi.fn().mockRejectedValue(new CrezError(ErrorCode.GEN_CONTENT_POLICY, 'higgsfield 400: nsfw',
        { status: 400, sent: true, accepted: false }, 502)) };
    vi.spyOn(providerRegistry, 'resolve').mockReturnValue(provider as never);
    const job = { name: JOB_NAME.GENERATION_SUBMIT, data: {
      orgId: fx.org.id, projectId: p.project.id, segmentId: p.segment.id, attempt: 1, traceId: 'rejected',
    } };
    await generationProcessor(job as never);

    const ledger = await readSpendLedger(prisma, fx.org.id);
    expect(ledger.net).toBe(0);      // 실제로 나간 돈은 없다
    expect(ledger.gross).toBe(6);    // 실패는 총량에 남아 "실패가 쏟아지는" 상황을 잡는다
    const entry = await prisma.spendEntry.findUniqueOrThrow({
      where: { segmentId_attempt: { segmentId: p.segment.id, attempt: 1 } },
    });
    expect(entry.status).toBe('FAILED');
    // 한도가 풀렸으므로 원인을 고친 뒤 다시 실행할 수 있다
    await expect(generation.generate(fx.user, p.project.id, {}, 'after-fix')).resolves.toBeTruthy();
  });

  it('결과물 정책 거부는 규칙 안에서 한 번 자동 재제출하고, 다시 거부되면 확정 실패한다', async () => {
    // 제공자는 결과물을 보고 nsfw를 판정한다 — 같은 요청이 통과할 때도 있어 첫 거부는 자동으로 다시 뽑는다.
    // 다만 재시도는 시도 한도·예산을 함께 쓰고 횟수가 묶여 있어야 한다. 아니면 한 구간이 돈을 계속 태운다.
    const fx = await fixture(60000); const p = await fx.project();
    const { job, data } = await paidJob(fx, p);
    const nsfw = async (target: { id: string; providerJobId: string | null }) => {
      vi.spyOn(providerRegistry, 'resolve').mockReturnValue({
        code: 'fake-paid',
        poll: vi.fn().mockResolvedValue({
          state: 'FAILED', errorCode: ErrorCode.GEN_CONTENT_POLICY, errorDetail: 'higgsfield: nsfw로 거부됨',
        }),
      } as never);
      await generationProcessor({ name: JOB_NAME.GENERATION_POLL, data: {
        ...data, generationJobId: target.id, providerJobId: target.providerJobId!, pollCount: 1,
      } } as never);
    };

    await nsfw(job);
    // 구간은 실패로 내려가지 않고 다음 시도로 넘어간다
    const afterFirst = await prisma.segment.findUniqueOrThrow({ where: { id: p.segment.id } });
    expect(afterFirst.status).toBe('GENERATING');
    expect(afterFirst.attemptCount).toBe(2);
    expect(f.generationAdd).toHaveBeenCalledWith(JOB_NAME.GENERATION_SUBMIT,
      expect.objectContaining({ segmentId: p.segment.id, attempt: 2, policyRetry: 1 }),
      expect.objectContaining({ jobId: `submit-${p.segment.id}-2` }));
    const retryEntry = await prisma.spendEntry.findUniqueOrThrow({
      where: { segmentId_attempt: { segmentId: p.segment.id, attempt: 2 } },
    });
    expect(retryEntry.status).toBe('RESERVED');
    expect(Number(retryEntry.amountCredits)).toBe(6);
    // 거부된 시도는 실지출에서 빠지고, 재시도 예약만 실지출에 남는다
    expect(await readSpendLedger(prisma, fx.org.id)).toEqual({ net: 6, gross: 12 });

    // 재제출이 제공자에 접수된 뒤 또 거부되는 상황
    const second = await prisma.generationJob.create({ data: {
      segmentId: p.segment.id, attempt: 2, modelId: fx.model.id, routingTrace: {}, params: { traceId: data.traceId },
      status: 'RUNNING', providerJobId: `provider-${randomUUID()}`, startedAt: new Date(),
    } });
    await prisma.spendEntry.update({
      where: { segmentId_attempt: { segmentId: p.segment.id, attempt: 2 } }, data: { status: 'SUBMITTED' },
    });
    f.generationAdd.mockClear();
    await nsfw(second);

    const afterSecond = await prisma.segment.findUniqueOrThrow({ where: { id: p.segment.id } });
    expect(afterSecond.status).toBe('FAILED');
    expect(afterSecond.attemptCount).toBe(2);
    expect(f.generationAdd).not.toHaveBeenCalled();
    expect(await prisma.spendEntry.count({ where: { segmentId: p.segment.id } })).toBe(2);
    expect(await readSpendLedger(prisma, fx.org.id)).toEqual({ net: 0, gross: 12 });
    // 왜 멈췄는지 화면에 남아야 한다 — 씨앗을 바꿔도 같은 판정이니 내용을 고치라는 안내
    const errors = f.emit.mock.calls.map(([e]) => e).filter((e) => e.type === 'ERROR');
    expect(errors.at(-1).payload.detail).toContain('프롬프트');
    expect(errors.at(-1).payload.policyRetry).toMatchObject({ retrying: false, rejections: 2, reason: 'LIMIT' });
  });

  it('지난 실행의 정책 거부는 이번 실행의 재시도 한도를 쓰지 않는다', async () => {
    // 전체 이력으로 세면, 사람이 프롬프트를 고쳐 다시 실행해도 지난 실행의 거부가 한도를 채워
    // 새 실행이 재시도 없이 바로 확정 실패한다 — 2026-09-26에 실제로 그렇게 됐다.
    const fx = await fixture(60000); const p = await fx.project();
    await prisma.generationJob.create({ data: {
      segmentId: p.segment.id, attempt: 1, modelId: fx.model.id, routingTrace: {},
      params: { traceId: 'previous-run' }, status: 'FAILED', errorCode: ErrorCode.GEN_CONTENT_POLICY,
      startedAt: new Date(Date.now() - 600000), finishedAt: new Date(Date.now() - 590000),
    } });
    const job = await prisma.generationJob.create({ data: {
      segmentId: p.segment.id, attempt: 2, modelId: fx.model.id, routingTrace: {}, params: { traceId: 'this-run' },
      status: 'RUNNING', providerJobId: `provider-${randomUUID()}`, startedAt: new Date(),
    } });
    await prisma.segment.update({ where: { id: p.segment.id }, data: { status: 'GENERATING', attemptCount: 1 } });
    await prisma.spendEntry.create({ data: { orgId: fx.org.id, projectId: p.project.id,
      segmentId: p.segment.id, attempt: 2, amountCredits: 6, status: 'SUBMITTED' } });
    vi.spyOn(providerRegistry, 'resolve').mockReturnValue({
      code: 'fake-paid',
      poll: vi.fn().mockResolvedValue({
        state: 'FAILED', errorCode: ErrorCode.GEN_CONTENT_POLICY, errorDetail: 'higgsfield: nsfw로 거부됨',
      }),
    } as never);
    await generationProcessor({ name: JOB_NAME.GENERATION_POLL, data: {
      orgId: fx.org.id, projectId: p.project.id, segmentId: p.segment.id, traceId: 'this-run',
      generationJobId: job.id, providerJobId: job.providerJobId!, pollCount: 1,
    } } as never);

    expect((await prisma.segment.findUniqueOrThrow({ where: { id: p.segment.id } })).status).toBe('GENERATING');
    expect(f.generationAdd).toHaveBeenCalledWith(JOB_NAME.GENERATION_SUBMIT,
      expect.objectContaining({ attempt: 3, policyRetry: 1 }), expect.anything());

    // 같은 거부를 중복 폴링이 또 보고해도 재제출은 한 번뿐이다 — 아니면 유료 생성이 두 번 나간다
    const again = await retryAfterContentPolicy({
      segmentId: p.segment.id, projectId: p.project.id, orgId: fx.org.id, traceId: 'this-run', failedAttempt: 2,
    });
    expect(again).toMatchObject({ retrying: false, reason: 'ALREADY' });
    expect(await prisma.spendEntry.count({ where: { segmentId: p.segment.id } })).toBe(2);

    // 그리고 그 중복 보고가 구간을 FAILED로 덮으면 안 된다 — 덮으면 방금 큐에 넣은 재제출이
    // segment.status !== 'GENERATING'에 걸려 조용히 건너뛰어지고, 예약만 고아로 남는다.
    const duplicate = await prisma.generationJob.create({ data: {
      segmentId: p.segment.id, attempt: 2, modelId: fx.model.id, routingTrace: {}, params: { traceId: 'this-run' },
      status: 'RUNNING', providerJobId: job.providerJobId, startedAt: new Date(),
    } }).catch(() => null);
    if (!duplicate) {
      // 같은 (segmentId, attempt)는 유일하다 — 중복 폴링은 같은 job 행을 다시 본다
      await prisma.generationJob.update({ where: { id: job.id }, data: { status: 'RUNNING' } });
    }
    await generationProcessor({ name: JOB_NAME.GENERATION_POLL, data: {
      orgId: fx.org.id, projectId: p.project.id, segmentId: p.segment.id, traceId: 'this-run',
      generationJobId: job.id, providerJobId: job.providerJobId!, pollCount: 2,
    } } as never);
    expect((await prisma.segment.findUniqueOrThrow({ where: { id: p.segment.id } })).status).toBe('GENERATING');
  });

  it('제공자 접수 여부가 불명확한 실패는 추정액을 남긴다', async () => {
    const fx = await fixture(6000); const p = await fx.project();
    await generation.generate(fx.user, p.project.id, {}, 'timeout');
    const provider = { code: 'fake-paid', planImages: () => ({ images: [], droppedReferenceIds: [] }),
      estimateCost: () => 6, submit: vi.fn().mockRejectedValue(new Error('provider timeout')) };
    vi.spyOn(providerRegistry, 'resolve').mockReturnValue(provider as never);
    const job = { name: JOB_NAME.GENERATION_SUBMIT, data: {
      orgId: fx.org.id, projectId: p.project.id, segmentId: p.segment.id, attempt: 1, traceId: 'timeout',
    } };
    await expect(generationProcessor(job as never)).rejects.toThrow('provider timeout');
    expect(await readSpendCredits(prisma, fx.org.id)).toBe(6);
    await expect(generation.generate(fx.user, p.project.id, {}, 'retry')).rejects.toThrow(/월 한도/);
    expect(provider.submit).toHaveBeenCalledTimes(1);
  });

  it('확정 DB 작업 중 장애가 나면 결과/상태가 함께 롤백되고 다시 확정할 수 있다', async () => {
    const fx = await fixture(); const p = await fx.project(); const { job, data } = await paidJob(fx, p);
    // 실제 DB trigger로 output INSERT 뒤 generation_job UPDATE를 실패시킨다.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION review_fail_finalize() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${job.id}'::uuid AND NEW.status = 'SUCCEEDED' THEN RAISE EXCEPTION 'injected finalize failure'; END IF;
      RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER review_fail_finalize BEFORE UPDATE ON generation_job FOR EACH ROW EXECUTE FUNCTION review_fail_finalize()');
    try {
      await expect(finalizeGeneration(job.id, data, result)).rejects.toThrow(/injected finalize failure/);
      expect(await prisma.generationOutput.findUnique({ where: { jobId: job.id } })).toBeNull();
      expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('RUNNING');
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER review_fail_finalize ON generation_job');
      await prisma.$executeRawUnsafe('DROP FUNCTION review_fail_finalize()');
    }
    await finalizeGeneration(job.id, data, result);
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
  });

  it('QC ACK 유실 뒤 reconciler가 인계를 복구해도 Redis 작업은 하나다', async () => {
    const fx = await fixture(); const p = await fx.project(); const { job, data } = await paidJob(fx, p);
    f.qcAdd.mockImplementationOnce(async (...args) => {
      await qcQueue.add(...args as Parameters<Queue['add']>);
      throw new Error('ACK lost');
    });
    await expect(finalizeGeneration(job.id, data, result)).rejects.toThrow('ACK lost');
    const output = await prisma.generationOutput.findUniqueOrThrow({ where: { jobId: job.id } });
    expect(output.qcQueuedAt).toBeNull();
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    await reconcileSubmittedJobs();
    expect((await prisma.generationOutput.findUniqueOrThrow({ where: { jobId: job.id } })).qcQueuedAt).not.toBeNull();
    const jobs = await qcQueue.getJobs(['waiting']);
    expect(jobs.filter((j) => j.data.outputId === output.id)).toHaveLength(1);
  });

  it('이전 버전에서 output만 저장된 시도도 폴링 재시도로 QC까지 복구한다', async () => {
    const fx = await fixture(); const p = await fx.project(); const { job, data } = await paidJob(fx, p);
    await prisma.generationOutput.create({ data: { jobId: job.id, storageKey: result.storageKey } });
    await generationProcessor({ name: JOB_NAME.GENERATION_POLL,
      data: { ...data, generationJobId: job.id, providerJobId: job.providerJobId },
    } as never);
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    expect((await prisma.segment.findUniqueOrThrow({ where: { id: p.segment.id } })).status).toBe('QC');
    expect(await readSpendCredits(prisma, fx.org.id)).toBe(6);
  });

  it('암호화된 소스 트랙을 실제 API에서 복호화해 매핑에 쓴다', async () => {
    const fx = await fixture(); const p = await fx.project();
    const video = await prisma.sourceVideo.create({ data: { projectId: p.project.id, storageKey: 'test/video' } });
    const track = await prisma.sourceTrack.create({ data: { sourceVideoId: video.id, trackIndex: 0,
      startMs: 0, endMs: 5000, timelineKey: 'test/track', quality: 0.9 } });
    const vector = Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0);
    await setSourceTrackCentroid(track.id, vector);
    await setProfileCentroids(fx.profile.id, vector, null);
    const ml = { assignIdentity: vi.fn().mockResolvedValue({ assignments: [] }) };
    const project = new ProjectService(prisma, {} as never, queue as never, audit as never, ml as never, rights as never);
    expect((await project.getTracks(fx.user, p.project.id, video.id)).tracks).toHaveLength(1);
    expect(ml.assignIdentity).toHaveBeenCalledWith(expect.objectContaining({
      tracks: [expect.objectContaining({ faceCentroid: vector })],
    }));
  });

  it('기존 DB 이관은 별도 한도와 무제한을 보존하고 스냅된 비용을 이관한다', async () => {
    const fx = await fixture(); const p = await fx.project(); const { job } = await paidJob(fx, p);
    await prisma.segment.update({ where: { id: p.segment.id }, data: { endMs: 4000 } });
    const custom = await fixture(100000);
    await prisma.spendPolicy.update({ where: { orgId: custom.org.id }, data: { updatedBy: (custom.user as { id: string }).id } });
    const unlimited = await fixture();
    await prisma.spendPolicy.update({ where: { orgId: unlimited.org.id }, data: { monthlyBudgetKrw: null } });
    await prisma.spendPolicy.update({ where: { orgId: fx.org.id }, data: { monthlyBudgetKrw: 100000 } });
    const migration = readFileSync(new URL('../../../packages/db/prisma/migrations/20260925000100_durable_generation_spend/migration.sql', import.meta.url), 'utf8');
    const rollback = new Error('rollback fixture schema');
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('DROP TABLE spend_entry');
      await tx.$executeRawUnsafe('ALTER TABLE generation_output DROP COLUMN qc_queued_at');
      for (const sql of migration.split(';').map((s) => s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(sql);
      expect(Number((await tx.spendPolicy.findUniqueOrThrow({ where: { orgId: fx.org.id } })).monthlyBudgetKrw)).toBe(300000);
      expect(Number((await tx.spendPolicy.findUniqueOrThrow({ where: { orgId: custom.org.id } })).monthlyBudgetKrw)).toBe(100000);
      expect((await tx.spendPolicy.findUniqueOrThrow({ where: { orgId: unlimited.org.id } })).monthlyBudgetKrw).toBeNull();
      const entry = await tx.spendEntry.findUniqueOrThrow({ where: { segmentId_attempt: { segmentId: p.segment.id, attempt: job.attempt } } });
      expect(Number(entry.amountCredits)).toBe(6); // 4초가 모델의 5초 길이로 올라간다.
      throw rollback;
    })).rejects.toBe(rollback);
  });
});
