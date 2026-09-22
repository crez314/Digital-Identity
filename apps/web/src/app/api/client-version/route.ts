/**
 * 웹 서버 프로세스의 부팅 식별자.
 *
 * 열려 있던 탭은 서버가 다시 떠도 예전 JS를 그대로 돌린다 — 개발 서버의 HMR 연결은 서버가 한 번
 * 내려가면 다시 붙지 않고, 운영 배포도 열린 탭을 갱신하지 않는다. 그런 탭은 이미 지운 기능(슬롯별
 * 업로드)이 살아 있고 새 기능(슬롯 간 드래그)이 없어서 "안 된다"는 말만 남는다.
 * 탭이 처음 받은 값과 지금 값이 다르면 새로고침하라고 알린다(StaleClientBanner).
 *
 * 라우트 모듈은 개발 중에 다시 평가될 수 있으므로 값을 globalThis에 둔다 — 프로세스가 바뀔 때만 바뀐다.
 */
const g = globalThis as { __crezWebBootId?: string };
g.__crezWebBootId ??= `${process.pid}-${Date.now().toString(36)}`;

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ bootId: g.__crezWebBootId }, { headers: { 'cache-control': 'no-store' } });
}
