import { describe, expect, it, vi } from 'vitest';
import { CrezError } from '@crez/shared';
import { MasterService } from '../modules/master/master.service';

/**
 * 30초~4분짜리는 5초 컷 수십 개를 이어 붙여 만든다.
 * 컷마다 QC를 통과해도 1번 컷과 12번 컷의 인물이 다르면 이어 붙인 결과는 사람이 바뀐 영상이 된다.
 * 마스터 결합 직전이 그것을 막을 마지막 지점이다.
 */
const user = { id: 'u1', orgId: 'org1' } as never;
const IDENTITY = 'identity-a';

function segment(segmentIndex: number, score: number | null) {
  const outputId = `out-${segmentIndex}`;
  return {
    segmentIndex, startMs: segmentIndex * 5000, endMs: (segmentIndex + 1) * 5000,
    status: 'PASSED', attemptCount: 1, acceptedOutputId: outputId,
    acceptReason: null,
    jobs: [{
      model: { code: 'higgsfield-kling25-pro-i2v' },
      seed: null, routingTrace: null,
      outputs: [{
        id: outputId, storageKey: `k-${segmentIndex}`,
        qcRuns: score === null ? [] : [{
          id: `qc-${segmentIndex}`, overallScore: score, rulesetVersion: 'qc-v2',
          perIdentity: { [IDENTITY]: { score } },
        }],
      }],
    }],
  };
}

function setup(segments: ReturnType<typeof segment>[], sequenceMaxSpread = 0.15) {
  const prisma = {
    project: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'p1', title: '1분 MV', projectType: 'MV', config: {},
        cast: [{ identityId: IDENTITY, identity: { code: 'CRZ-A008' }, profile: { version: 1, modelBundle: {} } }],
      }),
    },
    segment: { findMany: vi.fn().mockResolvedValue(segments) },
    qcRuleset: {
      findFirst: vi.fn().mockResolvedValue({
        thresholds: {
          perIdentityMin: 0.62, maxSpread: 0.12, overallMin: 0.65,
          driftDropRatio: 0.12, driftMinDurationSec: 1, blendMargin: 0.05, blendMinDurationSec: 0.6,
          swapMinDurationSec: 0.8, flickerZScore: 2.5, trackLostMinDurationSec: 0.5, minFrameQuality: 0.35,
          assignMinSimilarity: 0.35, sequenceMaxSpread,
        },
      }),
    },
    masterVideo: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'm1' }) },
  };
  const audit = { record: vi.fn() };
  const queue = { add: vi.fn().mockResolvedValue('job1') };
  const rights = { enforce: vi.fn().mockResolvedValue(undefined) };
  const svc = new MasterService(prisma as never, queue as never, audit as never, null as never, rights as never);
  return { svc, prisma, audit };
}

const input = { normalizeColor: true, normalizeTiming: true };

describe('마스터 결합 — 구간 간 인물 일관성 (§10.3)', () => {
  it('컷 사이 점수가 고르면 그대로 묶는다', async () => {
    const { svc, audit } = setup([segment(0, 0.71), segment(1, 0.75), segment(2, 0.69)]);
    const res = await svc.createMaster(user, 'p1', input, 't1');
    expect(res.masterId).toBe('m1');
    expect(audit.record.mock.calls[0][0].payload.sequenceOk).toBe(true);
  });

  it('컷마다 합격했어도 컷 사이 편차가 크면 결합을 막는다', async () => {
    const { svc } = setup([segment(0, 0.92), segment(1, 0.88), segment(2, 0.63)]);
    await expect(svc.createMaster(user, 'p1', input, 't1')).rejects.toThrow(CrezError);
  });

  it('막을 때 어느 구간이 문제인지 알려준다 — 재생성할 곳을 찾아야 한다', async () => {
    const { svc } = setup([segment(0, 0.92), segment(5, 0.6)]);
    await svc.createMaster(user, 'p1', input, 't1').then(
      () => { throw new Error('결합이 막혀야 한다'); },
      (e: CrezError) => {
        expect(e.message).toContain('5번');
        expect((e.detail as { sequence: { perIdentity: Array<{ worstSegmentIndex: number }> } })
          .sequence.perIdentity[0].worstSegmentIndex).toBe(5);
      },
    );
  });

  it('운영자가 확인하고 넘기면 진행하되 감사에 남긴다', async () => {
    const { svc, audit } = setup([segment(0, 0.92), segment(1, 0.6)]);
    const res = await svc.createMaster(user, 'p1', { ...input, ignoreSequenceCheck: true }, 't1');
    expect(res.masterId).toBe('m1');
    expect(audit.record.mock.calls[0][0].payload.sequenceIgnored).toBe(true);
  });

  it('QC 기록이 없는 구간(수동 승인)은 비교에서 빠진다', async () => {
    const { svc } = setup([segment(0, 0.71), segment(1, null), segment(2, 0.74)]);
    await expect(svc.createMaster(user, 'p1', input, 't1')).resolves.toBeTruthy();
  });

  it('구간이 하나면 비교 대상이 없어 통과한다', async () => {
    const { svc } = setup([segment(0, 0.4)]);
    await expect(svc.createMaster(user, 'p1', input, 't1')).resolves.toBeTruthy();
  });

  it('허용치는 ruleset에서 온다 — 넓히면 같은 결과가 통과한다', async () => {
    const { svc } = setup([segment(0, 0.92), segment(1, 0.63)], 0.4);
    await expect(svc.createMaster(user, 'p1', input, 't1')).resolves.toBeTruthy();
  });
});
