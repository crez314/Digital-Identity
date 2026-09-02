/**
 * crez-api 클라이언트.
 * 에러 본문은 §17 규약 { code, message, detail, traceId }로 통일되어 있으므로
 * 그대로 UI에 노출한다 — 운영자가 사유 코드를 보고 판단할 수 있어야 한다.
 */
const BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001/api/v1';

export interface ApiError {
  code: string;
  message: string;
  detail: unknown;
  traceId: string | null;
}

export class CrezApiError extends Error {
  constructor(readonly body: ApiError, readonly status: number) {
    super(`${body.code}: ${body.message}`);
  }
}

function devHeaders(): Record<string, string> {
  // AUTH_MODE=dev 개발 편의. 운영에서는 OIDC Bearer 토큰으로 대체된다(§1.1).
  const email = typeof window !== 'undefined' ? window.localStorage.getItem('crez.devUser') : null;
  return email ? { 'x-dev-user': email } : {};
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...devHeaders(), ...(init.headers ?? {}) },
    cache: 'no-store',
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new CrezApiError(body as ApiError, res.status);
  return body as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const put = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });
export const patch = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export const apiBase = BASE;
