import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertReferenceOriginsReachable } from '../lib/reference-origin';

afterEach(() => vi.unstubAllGlobals());

describe('생성 전 공개 저장소 연결 확인', () => {
  it('끊긴 임시 주소는 제출 전 오류로 알리고 서명을 오류에 남기지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(assertReferenceOriginsReachable([
      'https://expired.trycloudflare.com/private/image.jpg?X-Amz-Signature=secret',
    ])).rejects.toMatchObject({
      code: 'CREZ-GEN-002',
      detail: { host: 'expired.trycloudflare.com', reason: 'CONNECTION_FAILED', sent: false },
    });
  });

  it.each([502, 503, 530, 408, 429])('DNS가 살아 있어도 HTTP %i 장애는 차단한다', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
    await expect(assertReferenceOriginsReachable(['https://storage.example/a'])).rejects.toMatchObject({
      detail: { reason: `HTTP_${status}`, sent: false },
    });
  });

  it.each([200, 307, 400, 403, 404, 405])('비공개 저장소 루트의 HTTP %i 응답을 허용한다', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
    await expect(assertReferenceOriginsReachable(['https://storage.example/a'])).resolves.toBeUndefined();
  });

  it('같은 저장소를 한 번만 검사하고 파일 경로·서명은 보내지 않으며 리디렉션을 따라가지 않는다', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetch);
    await assertReferenceOriginsReachable([
      'https://storage.example/private/a.jpg?X-Amz-Signature=secret-a',
      'https://storage.example/private/b.jpg?X-Amz-Signature=secret-b',
      'https://other.example/private/c.jpg?X-Amz-Signature=secret-c',
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://storage.example', {
      method: 'HEAD', redirect: 'manual', signal: expect.any(AbortSignal),
    });
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://other.example', expect.any(Object));
  });

  it.each([
    'http://localhost:9000/a', 'http://127.0.0.2/a', 'http://[::1]:9000/a',
    'http://minio:9000/a', 'http://store.local/a', 'http://store.internal/a',
    'http://localhost.:9000/a', 'file:///tmp/a.jpg', 'not-a-url',
    'https://user:secret@storage.example/a',
  ])('외부에서 읽을 수 없는 주소 %s는 네트워크 요청 없이 막는다', async (url) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(assertReferenceOriginsReachable([url])).rejects.toMatchObject({ code: 'CREZ-GEN-002' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('응답이 없으면 5초 안에 중단한다', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError')));
    try {
      await expect(assertReferenceOriginsReachable(['https://storage.example/a'])).rejects.toMatchObject({
        detail: { reason: 'CONNECTION_FAILED' },
      });
      expect(timeout).toHaveBeenCalledWith(5000);
    } finally { timeout.mockRestore(); }
  });
});
