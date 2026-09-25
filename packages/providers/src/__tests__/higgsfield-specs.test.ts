import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, HIGGSFIELD_DURATIONS } from '@crez/shared';
import { ENDPOINT_SPECS, HiggsfieldProvider } from '../adapters/higgsfield';
import type { GenerationRequest, ModelDescriptor } from '../types';
import fixture from './fixtures/higgsfield-input-schemas.json';

/**
 * 어댑터가 만드는 요청 본문이 Higgsfield가 공개한 모드별 input_schema를 지키는지 확인한다.
 *
 * 스키마는 2026-09-22에 받은 그대로 fixtures에 두었다. 모델이 늘거나 제공자 규격이 바뀌면 fixture를 다시 받고
 * 이 테스트가 먼저 깨져야 한다 — 형식이 틀린 요청은 제출 단계에서 400으로 돌아와 구간 하나를 통째로 잃는다.
 */

interface JsonSchema {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

const schemas = (fixture as { schemas: Record<string, JsonSchema> }).schemas;

/** fixture 스키마가 쓰는 키워드만 검사하는 작은 검증기 */
function violations(body: Record<string, unknown>, schema: JsonSchema): string[] {
  const out: string[] = [];
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) if (!(key in body)) out.push(`필수 ${key} 없음`);
  for (const [key, value] of Object.entries(body)) {
    const p = props[key];
    if (!p) { out.push(`스키마에 없는 필드 ${key}`); continue; }
    const t = p.type;
    if (t === 'integer' && !Number.isInteger(value)) out.push(`${key}는 정수여야 함: ${JSON.stringify(value)}`);
    if (t === 'number' && typeof value !== 'number') out.push(`${key}는 숫자여야 함`);
    if (t === 'string' && typeof value !== 'string') out.push(`${key}는 문자열이어야 함`);
    if (t === 'boolean' && typeof value !== 'boolean') out.push(`${key}는 불리언이어야 함`);
    if (t === 'array' && !Array.isArray(value)) out.push(`${key}는 배열이어야 함`);
    if (p.enum && !p.enum.includes(value)) out.push(`${key}=${JSON.stringify(value)}는 허용값 ${JSON.stringify(p.enum)} 밖`);
    if (typeof value === 'number') {
      if (p.minimum !== undefined && value < p.minimum) out.push(`${key}=${value} < ${p.minimum}`);
      if (p.maximum !== undefined && value > p.maximum) out.push(`${key}=${value} > ${p.maximum}`);
    }
    if (typeof value === 'string' && p.minLength !== undefined && value.length < p.minLength) out.push(`${key} 너무 짧음`);
    if (Array.isArray(value)) {
      if (p.minItems !== undefined && value.length < p.minItems) out.push(`${key} ${value.length}개 < ${p.minItems}`);
      if (p.maxItems !== undefined && value.length > p.maxItems) out.push(`${key} ${value.length}개 > ${p.maxItems}`);
    }
  }
  return out;
}

const model = (code: string): ModelDescriptor => ({
  id: 'm', code, provider: 'EXTERNAL_API', endpoint: null,
  capabilities: { maxDurationMs: 10000, maxPersons: 3, modes: ['i2v'], maxResolution: 1080 },
  costPerSecond: 0.1, status: 'ACTIVE', metrics: {},
});

const ref = (id: string, n: number) => ({
  identityId: id, assetId: `${id}-${n}`, storageKey: `k-${id}-${n}`, signedUrl: `https://s3/${id}-${n}.jpg`,
  captureSlot: 'FRONT', expression: null, quality: 1 - n / 100,
});

const req = (over: Partial<GenerationRequest> = {}): GenerationRequest => ({
  traceId: 't1', segmentId: 's1', attempt: 1,
  durationMs: 6000, fps: 24, resolution: 1080, mode: 'reference', aspectRatio: '16:9',
  prompt: '무대 위 퍼포먼스', seed: 42, conditioningStrength: 0.7,
  cast: [{
    identityId: 'id-a', profileId: 'p-a', slotIndex: 0, appearance: {},
    references: Array.from({ length: 40 }, (_, i) => ref('id-a', i)),
  }],
  attachments: [],
  sourceVideoKey: null, sourceTracksKey: null,
  outputKey: 'projects/p1/segments/s1/attempt-1/output.mp4',
  ...over,
});

const fetchMock = vi.fn();
const ok = () => Promise.resolve({
  ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ status: 'queued', request_id: 'r1' })),
} as Response);

beforeEach(() => {
  process.env.HIGGSFIELD_KEY_ID = 'kid';
  process.env.HIGGSFIELD_KEY_SECRET = 'ksecret';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(ok);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function submittedBody(endpoint: string, over: Partial<GenerationRequest> = {}) {
  const p = new HiggsfieldProvider('higgsfield-test', { endpoint });
  await p.submit(req(over), model('higgsfield-test'));
  return JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown>;
}

describe('Higgsfield 모드별 요청 규격 — 공개 input_schema 계약', () => {
  it('규격표의 모든 경로에 허용 길이가 있다 (제출과 비용 견적이 같은 표를 쓴다)', () => {
    for (const ep of Object.keys(ENDPOINT_SPECS)) expect(HIGGSFIELD_DURATIONS[ep], ep).toBeDefined();
  });

  it('허용 길이가 스키마의 범위·enum과 같다', () => {
    for (const [ep, s] of Object.entries(schemas)) {
      const d = s.properties?.duration;
      const table = HIGGSFIELD_DURATIONS[ep];
      if (d?.enum) expect([...table], ep).toEqual(d.enum);
      else expect([table[0], table[table.length - 1]], ep).toEqual([d?.minimum, d?.maximum]);
    }
  });

  const cases: Array<[string, Partial<GenerationRequest>]> = [];
  for (const ep of Object.keys(schemas)) {
    for (const durationMs of [2000, 6000, 40000]) {
      for (const resolution of [720, 1080, 2160]) {
        for (const aspectRatio of ['16:9', '9:16'] as const) cases.push([ep, { durationMs, resolution, aspectRatio }]);
      }
    }
  }

  it.each(cases)('%s — 길이·해상도·비율이 무엇이든 스키마를 지킨다 %j', async (ep, over) => {
    const body = await submittedBody(ep, over);
    expect(violations(body, schemas[ep])).toEqual([]);
  });
});

describe('Higgsfield 새 모델 — 요청 본문', () => {
  it('seedance 2.5 reference는 인물당 상한(8장)까지 넣고 오디오를 끈다', async () => {
    const body = await submittedBody('/bytedance/seedance-2.5/reference-to-video');
    // 사진이 40장 있어도 인물당 8장이다 — 워커가 인물당 8장까지 고른다(pickReferences)
    expect(body.image_urls).toHaveLength(8);
    expect(body).toMatchObject({ duration: 6, resolution: '720p', aspect_ratio: '16:9', generate_audio: false });
    expect(body.image_url).toBeUndefined();
  });

  it('여러 명이면 인물마다 고르게 들어간다 — 한 사람이 자리를 다 차지하지 않는다', async () => {
    const cast = ['a', 'b', 'c', 'd'].map((id, slotIndex) => ({
      identityId: `id-${id}`, profileId: `p-${id}`, slotIndex, appearance: {},
      references: Array.from({ length: 8 }, (_, i) => ref(`id-${id}`, i)),
    }));
    const body = await submittedBody('/bytedance/seedance-2.5/reference-to-video', { cast });
    const urls = body.image_urls as string[];
    // 4명 × 8장 = 32장이지만 스펙 상한이 30장이라 거기서 끊긴다
    expect(urls).toHaveLength(30);
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(urls.filter((u) => u.includes(`id-${id}-`)).length).toBeGreaterThanOrEqual(7);
    }
    // 대표 사진(품질 1위)이 인물마다 먼저 들어간다
    expect(urls.slice(0, 4)).toEqual(['a', 'b', 'c', 'd'].map((id) => `https://s3/id-${id}-0.jpg`));
  });

  it('seedance 2.5는 720p가 최대라 1080 요청도 720p로 보낸다', async () => {
    expect((await submittedBody('/bytedance/seedance-2.5/image-to-video', { resolution: 1080 })).resolution).toBe('720p');
  });

  it('kling 3.0은 sound로 오디오를 끄고, 스키마에 없는 negative_prompt는 보내지 않는다', async () => {
    const body = await submittedBody('/kling-video/v3.0/pro/image-to-video', { mode: 'i2v' });
    expect(body).toMatchObject({ sound: 'off', cfg_scale: 0.3, image_url: 'https://s3/id-a-0.jpg' });
    expect(body.negative_prompt).toBeUndefined();
    expect(body.generate_audio).toBeUndefined();
  });

  it('minimax h3는 해상도가 2K 하나뿐이고 5초 미만은 5초로 올린다', async () => {
    const body = await submittedBody('/minimax/h3/reference-to-video', { durationMs: 3000 });
    expect(body).toMatchObject({ resolution: '2K', duration: 5 });
    expect(body.image_urls).toHaveLength(8);
  });

  it('hailuo 2.3은 제공자 프롬프트 재작성을 끈다 — 신원 고정 문구가 사라지지 않게', async () => {
    expect((await submittedBody('/minimax/hailuo-2.3/standard/image-to-video')).prompt_optimizer).toBe(false);
  });

  it('비율 파라미터가 있는 모델에는 프로젝트 비율을 넘기고, 없는 모델에는 보내지 않는다', async () => {
    expect((await submittedBody('/kling-video/o3/image-reference', { aspectRatio: '9:16' })).aspect_ratio).toBe('9:16');
    fetchMock.mockClear();
    // kling 3.0 i2v 스키마에는 비율이 없다 — 출력이 시작 이미지 비율을 따른다
    expect((await submittedBody('/kling-video/v3.0/std/image-to-video', { aspectRatio: '9:16' })).aspect_ratio).toBeUndefined();
  });

  it('규격을 모르는 경로는 제출하지 않는다 — 옛 형식으로 보내 400을 받는 대신 원인을 남긴다', async () => {
    const p = new HiggsfieldProvider('higgsfield-x', { endpoint: '/unknown/model/image-to-video' });
    await expect(p.submit(req(), model('higgsfield-x'))).rejects.toMatchObject({ code: ErrorCode.GEN_NO_CAPABLE_MODEL });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Higgsfield — 소리(음악) 생성', () => {
  it('요청하면 모델별 필드로 소리를 켠다', async () => {
    const seedance = await submittedBody('/bytedance/seedance-2.5/reference-to-video', { audio: true });
    expect(seedance.generate_audio).toBe(true);
    fetchMock.mockClear();
    const kling = await submittedBody('/kling-video/v3.0/pro/image-to-video', { audio: true });
    expect(kling.sound).toBe('on');
  });

  it('요청하지 않으면 끈다 — 기본은 무음이다', async () => {
    const seedance = await submittedBody('/bytedance/seedance-2.5/reference-to-video');
    expect(seedance.generate_audio).toBe(false);
    fetchMock.mockClear();
    const kling = await submittedBody('/kling-video/v3.0/pro/image-to-video');
    expect(kling.sound).toBe('off');
  });

  it('소리를 못 만드는 모델에는 필드를 보내지 않는다 — 스키마에 없는 값을 보내면 400이다', async () => {
    const body = await submittedBody('/minimax/h3/reference-to-video', { audio: true });
    expect(body.generate_audio).toBeUndefined();
    expect(body.sound).toBeUndefined();
    expect(violations(body, schemas['/minimax/h3/reference-to-video'])).toEqual([]);
  });

  it('소리를 켜면 아는 경우 더 높은 단가로 견적한다 — 한도가 모자라게 계산되면 안 된다', () => {
    const p = new HiggsfieldProvider('t', { endpoint: '/bytedance/seedance-2.5/reference-to-video' });
    const withAudioRate = {
      ...model('t'),
      costPerSecond: 0.2057,
      capabilities: { ...model('t').capabilities, costPerSecondAudio: 0.4623 },
    };
    expect(p.estimateCost(req({ durationMs: 5000, audio: true }), withAudioRate)).toBeCloseTo(0.4623 * 5, 4);
    expect(p.estimateCost(req({ durationMs: 5000 }), withAudioRate)).toBeCloseTo(0.2057 * 5, 4);
    // 오디오 단가를 모르는 모델은 기본 단가를 그대로 쓴다
    expect(p.estimateCost(req({ durationMs: 5000, audio: true }), { ...model('t'), costPerSecond: 0.2057 }))
      .toBeCloseTo(0.2057 * 5, 4);
  });
});
