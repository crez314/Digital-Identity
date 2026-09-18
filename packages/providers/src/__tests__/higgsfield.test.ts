import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HiggsfieldProvider, classifyHiggsfieldError, mapStatus } from '../adapters/higgsfield';
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
  durationMs: 6000, fps: 24, resolution: 720, mode: 'reference', aspectRatio: '16:9',
  prompt: '무대 위 퍼포먼스', seed: 42, conditioningStrength: 0.7,
  cast: [{
    identityId: 'id-a', profileId: 'p-a', slotIndex: 0, appearance: {},
    references: [
      { identityId: 'id-a', assetId: 'a1', storageKey: 'k1', signedUrl: 'https://s3/1.jpg', captureSlot: 'FRONT', expression: null, quality: 0.9 },
      { identityId: 'id-a', assetId: 'a2', storageKey: 'k2', signedUrl: 'https://s3/2.jpg', captureSlot: 'LEFT_45', expression: null, quality: 0.7 },
    ],
  }],
  attachments: [],
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

  it('배경·의상 참고 이미지를 인물 얼굴 다음 자리에 넣고, 남는 자리를 추가 얼굴로 채운다', async () => {
    fetchMock.mockReturnValue(ok({ status: 'queued', request_id: 'r1' }));
    const p = new HiggsfieldProvider('higgsfield-veo31-reference', { endpoint: '/veo3.1/reference-to-video' });
    const withRefs = req({
      attachments: [
        { referenceId: 'bg', kind: 'BACKGROUND', slotIndex: null, storageKey: 'kb', signedUrl: 'https://s3/bg.jpg' },
        { referenceId: 'out', kind: 'OUTFIT', slotIndex: 0, storageKey: 'ko', signedUrl: 'https://s3/outfit.jpg' },
      ],
    });

    await p.submit(withRefs, model);
    const urls: string[] = JSON.parse(fetchMock.mock.calls[0][1].body).image_urls;
    expect(urls).toEqual(['https://s3/1.jpg', 'https://s3/outfit.jpg', 'https://s3/bg.jpg']);
    expect(p.planImages(withRefs).droppedReferenceIds).toEqual([]);
  });

  it('image-to-video는 시작 이미지 1장만 받으므로 참고 이미지는 전달되지 않은 것으로 기록한다', () => {
    const p = new HiggsfieldProvider('higgsfield-veo31-i2v', { endpoint: '/veo3.1/image-to-video' });
    const plan = p.planImages(req({
      mode: 'i2v',
      attachments: [{ referenceId: 'bg', kind: 'BACKGROUND', slotIndex: null, storageKey: 'kb', signedUrl: 'https://s3/bg.jpg' }],
    }));
    expect(plan.images.map((i) => i.url)).toEqual(['https://s3/1.jpg']);
    expect(plan.droppedReferenceIds).toEqual(['bg']);
  });

  it('인물 레퍼런스 없이 참고 이미지만 있으면 제출하지 않는다', async () => {
    const p = new HiggsfieldProvider('higgsfield-veo31-reference', { endpoint: '/veo3.1/reference-to-video' });
    const onlyBg = req({
      cast: [{ identityId: 'a', profileId: 'p', slotIndex: 0, appearance: {}, references: [] }],
      attachments: [{ referenceId: 'bg', kind: 'BACKGROUND', slotIndex: null, storageKey: 'kb', signedUrl: 'https://s3/bg.jpg' }],
    });
    await expect(p.submit(onlyBg, model)).rejects.toThrow(/인물 레퍼런스/);
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('kling 경로는 정수 duration을 쓰고 신원 조건화를 뒤집어 cfg_scale로 넘긴다', async () => {
    fetchMock.mockReturnValue(ok({ status: 'queued', request_id: 'r1' }));
    const p = new HiggsfieldProvider('higgsfield-kling25-pro-i2v', {
      endpoint: '/kling-video/v2.5-turbo/pro/image-to-video',
    });
    await p.submit(req({ durationMs: 9000, mode: 'i2v' }), model);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.image_url).toBe('https://s3/1.jpg');   // 단수 필드
    expect(body.duration).toBe(10);                     // 정수
    // cfg_scale은 스펙상 "프롬프트 준수 강도"다. 신원 조건화 0.7은 프롬프트 준수 0.3으로 가야 한다 —
    // 그대로 0.7을 넘기면 재생성 1단계가 조건화를 올릴수록 인물이 더 이탈한다(2026-09-16 실측).
    expect(body.cfg_scale).toBe(0.3);
  });

  it('kling에는 신원 유지용 negative_prompt를 함께 보낸다', async () => {
    fetchMock.mockReturnValue(ok({ status: 'queued', request_id: 'r1' }));
    const p = new HiggsfieldProvider('higgsfield-kling25-pro-i2v', {
      endpoint: '/kling-video/v2.5-turbo/pro/image-to-video',
    });
    await p.submit(req({ mode: 'i2v' }), model);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.negative_prompt).toContain('different person');
    expect(body.negative_prompt).toContain('scene change');
  });

  it('화면 비율은 프로젝트 설정을 그대로 넘긴다 (veo3.1)', async () => {
    fetchMock.mockReturnValue(ok({ status: 'queued', request_id: 'r1' }));
    const p = new HiggsfieldProvider('higgsfield-veo31-reference', { endpoint: '/veo3.1/reference-to-video' });

    await p.submit(req(), model);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).aspect_ratio).toBe('16:9');

    fetchMock.mockClear();
    await p.submit(req({ aspectRatio: '9:16' }), model);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).aspect_ratio).toBe('9:16');
  });

  it('kling 스펙에는 화면 비율 파라미터가 없다 — 본문에 넣지 않고 시작 이미지 비율을 따른다', async () => {
    fetchMock.mockReturnValue(ok({ status: 'queued', request_id: 'r1' }));
    const p = new HiggsfieldProvider('higgsfield-kling25-pro-i2v', {
      endpoint: '/kling-video/v2.5-turbo/pro/image-to-video',
    });
    await p.submit(req({ mode: 'i2v', aspectRatio: '9:16' }), model);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).aspect_ratio).toBeUndefined();
  });
});

describe('Higgsfield 어댑터 — 오류 분류 (§17)', () => {
  it('모델 접근 불가를 콘텐츠 정책 위반으로 기록하지 않는다', () => {
    // 2026-09-16 veo3.1 reference-to-video 실패가 CREZ-GEN-003(콘텐츠 정책)으로 남아 원인을 잘못 짚게 했다
    expect(classifyHiggsfieldError('model_not_found')).toBe('CREZ-GEN-001');
    expect(classifyHiggsfieldError('model_disabled')).toBe('CREZ-GEN-001');
    // 423 model_blocked — 계정에서 막힌 모델. 재시도해도 소용없다(2026-09-18 kling 2.1 계열)
    expect(classifyHiggsfieldError('model_blocked')).toBe('CREZ-GEN-001');
  });

  it('크레딧 부족은 quota 코드로 분류한다', () => {
    expect(classifyHiggsfieldError('not_enough_credits')).toBe('CREZ-GEN-004');
  });

  it('실제 콘텐츠 정책 거부만 CREZ-GEN-003이고 나머지는 제공자 오류다', () => {
    expect(classifyHiggsfieldError('nsfw content detected')).toBe('CREZ-GEN-003');
    expect(classifyHiggsfieldError(": 'prompt' is a required property")).toBe('CREZ-GEN-002');
    expect(classifyHiggsfieldError('internal server error')).toBe('CREZ-GEN-002');
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
