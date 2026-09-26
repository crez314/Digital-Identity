/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /**
   * 프로덕션 빌드는 개발 서버와 다른 폴더에 쓴다.
   * `next dev`와 `next build`가 같은 .next를 공유하면, 개발 서버가 돌아가는 중에 빌드가 한 번만
   * 실행돼도 개발 서버가 참조하던 청크가 사라져 모든 페이지가 500이 된다
   * ("Cannot find module './vendor-chunks/...'"). 실제로 이 저장소에서 두 번 발생했다.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  transpilePackages: ['@crez/contracts'],
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001/api/v1',
  },
};
export default nextConfig;
