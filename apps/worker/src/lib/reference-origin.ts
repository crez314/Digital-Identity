import { CrezError, ErrorCode } from '@crez/shared';

const LOCAL_HOSTS = new Set(['localhost', '0.0.0.0', '[::1]', '[::]', 'minio', 'host.docker.internal']);

function unavailable(host: string | null, reason: string): CrezError {
  return new CrezError(
    ErrorCode.GEN_PROVIDER_ERROR,
    '참고 이미지의 공개 주소에 연결할 수 없습니다 — 터널 연결과 S3_PUBLIC_ENDPOINT를 확인하고 워커를 재시작한 뒤 다시 실행하세요',
    { host, reason, sent: false },
    422,
  );
}

/**
 * 생성 제출 전에 공개 저장소의 연결 상태를 확인한다.
 * 이미지 경로·서명·인증정보는 보내지 않고 origin에 HEAD만 요청한다. 같은 저장소는 한 번만 검사한다.
 * 비공개 S3/MinIO의 루트는 400·403·404·405를 반환할 수 있어 이를 연결 실패로 보지 않는다.
 * 이 검사는 DNS·터널·서버 장애를 잡으며, 개별 파일의 존재나 서명 유효성을 보장하지는 않는다.
 */
export async function assertReferenceOriginsReachable(urls: readonly string[]): Promise<void> {
  const origins = new Set<string>();
  for (const value of urls) {
    let url: URL;
    try { url = new URL(value); } catch { throw unavailable(null, 'INVALID_URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw unavailable(null, 'INVALID_URL');
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (LOCAL_HOSTS.has(host) || host.startsWith('127.') || host.endsWith('.localhost')
      || host.endsWith('.local') || host.endsWith('.internal')) {
      throw unavailable(host, 'LOCAL_ADDRESS');
    }
    origins.add(url.origin);
  }

  for (const origin of origins) {
    const host = new URL(origin).hostname;
    let response: Response;
    try {
      response = await fetch(origin, {
        method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000),
      });
    } catch {
      // fetch 오류에는 URL이 섞일 수 있다. 로그·화면에는 호스트와 고정된 사유만 남긴다.
      throw unavailable(host, 'CONNECTION_FAILED');
    }
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      throw unavailable(host, `HTTP_${response.status}`);
    }
  }
}
