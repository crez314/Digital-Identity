export type AuthMode = 'dev' | 'oidc';

/**
 * §16 인증 모드 검사 — 기동 시점에 호출한다(fail-closed).
 *
 * v1.2까지는 `AUTH_MODE !== 'oidc'`이면 dev가 되어, 운영 배포에서 변수 하나만 빠져도
 * x-dev-user 헤더로 아무 사용자나 사칭할 수 있었다. 이제는 모드를 명시해야 기동한다.
 */
export function assertAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const mode = env.AUTH_MODE;
  if (mode === 'oidc') {
    if (!env.OIDC_ISSUER) throw new Error('AUTH_MODE=oidc에는 OIDC_ISSUER가 필요합니다');
    if (!env.OIDC_AUDIENCE) {
      throw new Error('AUTH_MODE=oidc에는 OIDC_AUDIENCE가 필요합니다 — 없으면 같은 발급자가 다른 서비스용으로 발급한 토큰도 통과합니다');
    }
    return 'oidc';
  }
  if (mode === 'dev') {
    if (env.NODE_ENV === 'production') {
      throw new Error('NODE_ENV=production에서는 AUTH_MODE=dev를 쓸 수 없습니다 — 헤더만으로 사용자를 사칭할 수 있습니다');
    }
    return 'dev';
  }
  throw new Error(`AUTH_MODE는 'oidc' 또는 'dev'여야 합니다 (현재: ${mode === undefined ? '미설정' : `'${mode}'`})`);
}

/**
 * 요청 처리 중의 판단. 기동 검사를 거치지 않은 경로(테스트, 다른 진입점)에서도
 * 명시적 dev이면서 운영이 아닐 때만 참이다. 그 밖에는 전부 OIDC로 처리한다.
 */
export function isDevAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_MODE === 'dev' && env.NODE_ENV !== 'production';
}
