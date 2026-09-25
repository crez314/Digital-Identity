import { defineConfig } from 'vitest/config';
const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('TEST_DATABASE_URL and TEST_REDIS_URL must point to disposable test services');
if (!/_(test|review)$/.test(new URL(databaseUrl).pathname)) {
  throw new Error('Integration database name must end in _test or _review');
}
export default defineConfig({
  esbuild: { tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } },
  test: {
    include: ['apps/worker/tests/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 15000,
    env: {
      DATABASE_URL: databaseUrl, REDIS_URL: redisUrl,
      FIELD_ENCRYPTION_KEY: '11'.repeat(32), BIOMETRIC_ENCRYPTION_KEY: '22'.repeat(32),
    },
  },
});
