import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HiggsfieldProvider, mapStatus } from '../adapters/higgsfield';
import type { GenerationRequest, ModelDescriptor } from '../types';

/**
 * 이 테스트는 Higgsfield 공식 OpenAPI 스펙(v2.0.0)의 계약을 고정한다.
 * 제공자 규격이 바뀌면 여기서 먼저 깨져야 한다 — 운영에서 깨지면 늦다.
 */

const model: ModelDescriptor = {
  id: 'm1', code: 'higgsfield-veo31-reference', provider: 'EXTERNAL_API',
  endpoint: null,
  capabilities: { maxDurationMs: 8000, maxPersons: 3, modes: ['reference'], maxResolution: 1080 },
  costPerSecond: 0.4, status: 'ACTIVE', metrics: {},
};

const req = (over: Partial<GenerationRequest> = {}): GenerationRequest => ({
  traceId: 't1', segmentId: 's1', attempt: 1,
  durationMs: 6000, fps: 24, resolution: 720, mode: 'reference',
  prompt: '무대 위 퍼포먼스', seed: 42, conditioningStrength: 0.7,
  cast: [{
    identityId: 'id-a', profileId: 'p-a', slotIndex: 0, appearance: {},
    references: [
      { identityId: 'id-a', assetId: 'a1', storageKey: 'k1', signedUrl: 'https://s3/1.jpg', captureSlot: 'FRONT', expression: null, quality: 0.9 },
      { identityId: 'id-a', assetId: 'a2', storageKey: 'k2', signedUrl: 'https://s3/2.jpg', captureSlot: 'LEFT_45', expression: null, quality: 0.7 },
    ],
  }],
  sourceVideoKey: null, sourceTracksKey: null,
  outputKey: 'projects/p1/segments/s1/attempt-1/output.mp4',
  ...over,
});

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.HIGGSFIELD_KEY_ID = 'kid';
  process.env.HIGGSFIELD_KEY_SECRET = 'ksecret';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

const ok = (body: unknown) => Promise.resolve({
  ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)),
} as Response);

describe('Higgsfield 어댑터 — 인증', () => {
  it('Bearer가 아니라 Key {id}:{secret} 형식을 쓴다', async () => {
    fetchMock.mockReturnValue(ok({ status: 'queued', request_id: 'r1' }));
    const p = new HiggsfieldProvider('higgsfield-veo31-reference', { endpoint: '/veo3.1/reference-to-video' });
    await p.submit(req(), model);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.authorization).toBe('Key kid:ksecret');
    expect(headers.authorization).not.toMatch(/Bearer/);
  });

  it('자격증명이 없으면 조용히 mock으로 떨어지지 않고 실패한다', async () => {
    delete process.env.HIGGSFIELD_KEY_ID;
    delete process.env.HIGGSFIELD_KEY_SECRET;
    const p = new HiggsfieldProvider('higgsfield-veo31-reference', { endpoint: '/veo3.1/reference-to-video' });
    await expect(p.submit(req(), model)).rejects.toThrow(/HIGGSFIELD_KEY_ID/);
  });
});

describe('Higgsfield 어댑터 — reference-to-video 요청 본문', () => {
  it('스펙 필드명을 그대로 쓰고 레퍼런스를 3장으로 제한한다', async () => {
    fetchMock.mockReturnValue(ok({ status: 'queued', request_id: 'r1' }));
    const p = new HiggsfieldProvider('higgsfield-veo31-reference', { endpoint: '/veo3.1/reference-to-video' });

    const many = req({
      cast: [{
        identityId: 'id-a', profileId: 'p', slotIndex: 0, appearance: {},
        references: Array.from({ length: 6 }, (_, i) => ({
          identityId: 'id-a', assetId: `a${i}`, storageKey: `k${i}`,
          signedUrl: `https://s3/${i}.jpg`, captureSlot: null, expression: null, quality: 1 - i * 0.1,
        })),
      }],
    });
    await p.submit(many, model);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Object.keys(body).sort()).toEqual(
      ['aspect_ratio', 'duration', 'generate_audio', 'image_urls', 'prompt', 'resolution'],
    );
    expect(body.image_urls).toHaveLength(3);          // 스펙 maxItems=3
    expect(body.duration).toBe('6');                   // veo3.1은 문자열 enum
    expect(body.resolution).toBe('720');               // 'p' 없는 표기
  });

  it('여러 인물의 레퍼런스를 라운드로빈으로 배분한다', async () => {
    fetchMock.mockReturnValue(ok({ status: 'queued', request_id: 'r1' }));
    const p = new HiggsfieldProvider('higgsfield-veo31-reference', { endpoint: '/veo3.1/reference-to-video' });

    const mk = (id: string) => ({
      identityId: id, profileId: 'p', slotIndex: 0, appearance: {},
      references: [1, 2, 3].map((i) => ({
        identityId: id, assetId: `${id}-${i}`, storageKey: 'k',
        signedUrl: `https://s3/${id}-${i}.jpg`, captureSlot: null, expression: null, quality: 1 / i,
      })),
    });
    await p.submit(req({ cast: [mk('A'), mk('B')] }), model);

    const urls: string[] = JSON.parse(fetchMock.mock.calls[0][1].body).image_urls;
    // 한 인물이 3장을 독식하면 다른 인물의 신원이 전혀 조건화되지 않는다
    expect(urls.filter((u) => u.includes('A-')).length).toBeGreaterThan(0);
    expect(urls.filter((u) => u.includes('B-')).length).toBeGreaterThan(0);
  });

  it('레퍼런스가 없으면 제출하지 않는다', async () => {
    const p = new HiggsfieldProvider('higgsfield-veo31-reference', { endpoint: '/veo3.1/reference-to-video' });
    const none = req({ cast: [{ identityId: 'a', profileId: 'p', slotIndex: 0, appearance: {}, references: [] }] });
    await expect(p.submit(none, model)).rejects.toThrow(/레퍼런스 이미지/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('세그먼트 길이를 제공자 허용 enum으로 스냅한다', async () => {
    fetchMock.mockReturnValue(ok({ status: 'queued', request_id: 'r1' }));
    const p = new HiggsfieldProvider('higgsfield-veo31-reference', { endpoint: '/veo3.1/reference-to-video' });
    await p.submit(req({ durationMs: 5200 }), model);   // 5.2초 → veo3.1은 4/6/8만 허용
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).duration).toBe('6');
  });

  it('kling 경로는 정수 duration과 cfg_scale을 쓴다', async () => {
    fetchMock.mockReturnValue(ok({ status: 'queued', request_id: 'r1' }));
    const p = new HiggsfieldProvider('higgsfield-kling25-pro-i2v', {
      endpoint: '/kling-video/v2.5-turbo/pro/image-to-video',
    });
    await p.submit(req({ durationMs: 9000, mode: 'i2v' }), model);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.image_url).toBe('https://s3/1.jpg');   // 단수 필드
    expect(body.duration).toBe(10);                     // 정수
    expect(body.cfg_scale).toBe(0.7);
  });
});

describe('Higgsfield 어댑터 — 상태 매핑', () => {
  it('nsfw는 콘텐츠 정책 거부로 매핑되어 재시도되지 않는다', () => {
    const r = mapStatus({ status: 'nsfw', request_id: 'r1' });
    expect(r.state).toBe('FAILED');
    expect(r.errorCode).toBe('CREZ-GEN-003');
  });

  it('failed는 제공자 오류(재시도 대상)로 매핑된다', () => {
    expect(mapStatus({ status: 'failed', request_id: 'r' }).errorCode).toBe('CREZ-GEN-002');
  });

  it('queued/in_progress는 진행 중이다', () => {
    expect(mapStatus({ status: 'queued', request_id: 'r' }).state).toBe('RUNNING');
    expect(mapStatus({ status: 'in_progress', request_id: 'r' }).state).toBe('RUNNING');
  });

  it('completed와 canceled를 구분한다', () => {
    expect(mapStatus({ status: 'completed', request_id: 'r' }).state).toBe('SUCCEEDED');
    expect(mapStatus({ status: 'canceled', request_id: 'r' }).state).toBe('CANCELLED');
  });
});

describe('Higgsfield 어댑터 — 결과 수집', () => {
  it('status 응답의 video.url을 결과로 돌려준다', async () => {
    fetchMock.mockReturnValue(ok({
      status: 'completed', request_id: 'r1', video: { url: 'https://cdn.higgsfield.ai/out.mp4' },
    }));
    const p = new HiggsfieldProvider('higgsfield-veo31-reference', { endpoint: '/veo3.1/reference-to-video' });
    const r = await p.fetchResult('r1', req(), model);
    expect(r.storageKey).toBe('https://cdn.higgsfield.ai/out.mp4');
    expect(r.durationMs).toBe(6000);
    expect(fetchMock.mock.calls[0][0]).toContain('/requests/r1/status');
  });

  it('완료인데 video.url이 없으면 실패로 처리한다', async () => {
    fetchMock.mockReturnValue(ok({ status: 'completed', request_id: 'r1' }));
    const p = new HiggsfieldProvider('higgsfield-veo31-reference', { endpoint: '/veo3.1/reference-to-video' });
    await expect(p.fetchResult('r1', req(), model)).rejects.toThrow(/video\.url/);
  });

  it('취소는 스펙 경로를 호출한다', async () => {
    fetchMock.mockReturnValue(ok({}));
    const p = new HiggsfieldProvider('higgsfield-veo31-reference', { endpoint: '/veo3.1/reference-to-video' });
    await p.cancel('r9');
    expect(fetchMock.mock.calls[0][0]).toContain('/requests/r9/cancel');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });
});
