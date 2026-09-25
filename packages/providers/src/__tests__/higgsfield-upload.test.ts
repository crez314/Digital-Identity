import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HiggsfieldProvider } from '../adapters/higgsfield';

/**
 * 입력 파일을 제공자 스토리지에 올리는 경로 (docs: concepts/file-uploads).
 * 이 경로가 있어야 우리 스토리지를 인터넷에 공개하지 않고도 생성할 수 있다.
 */
const fetchMock = vi.fn();
beforeEach(() => {
  process.env.HIGGSFIELD_KEY_ID = 'kid';
  process.env.HIGGSFIELD_KEY_SECRET = 'ksecret';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

const provider = () => new HiggsfieldProvider('higgsfield-test', { endpoint: '/bytedance/seedance-2.5/reference-to-video' });
const ticket = {
  public_url: 'https://cdn.example/abc.jpg',
  upload_url: 'https://s3.example/put?sig=1',
  upload_headers: { 'Content-Type': 'image/jpeg', 'x-amz-tagging': 'retention=temporary' },
};

describe('Higgsfield 입력 파일 업로드', () => {
  it('업로드 주소를 받아 파일을 올리고 공개 주소를 돌려준다', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(ticket)) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const url = await provider().uploadAsset(new Uint8Array([1, 2, 3]), 'image/jpeg');
    expect(url).toBe('https://cdn.example/abc.jpg');

    const [ticketUrl, ticketInit] = fetchMock.mock.calls[0];
    expect(String(ticketUrl)).toContain('/files/generate-upload-url');
    expect(JSON.parse(ticketInit.body)).toEqual({ content_type: 'image/jpeg' });
    expect(ticketInit.headers.authorization).toBe('Key kid:ksecret');

    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(putUrl).toBe(ticket.upload_url);
    expect(putInit.method).toBe('PUT');
    // 제공자가 준 헤더를 그대로 쓴다
    expect(putInit.headers).toEqual(ticket.upload_headers);
    // presigned 주소에 우리 자격증명을 붙이면 서명이 깨진다
    expect(JSON.stringify(putInit.headers)).not.toContain('ksecret');
  });

  it('업로드가 실패하면 과금 없는 실패로 표시해 던진다', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(ticket)) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    await expect(provider().uploadAsset(new Uint8Array([1]), 'image/jpeg'))
      .rejects.toMatchObject({ detail: { status: 403, accepted: false } });
  });

  it('발급 응답이 비면 제출로 넘어가지 않는다', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('{}') } as Response);
    await expect(provider().uploadAsset(new Uint8Array([1]), 'image/jpeg')).rejects.toThrow(/업로드 주소/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
