import pino from 'pino';

/** trace ID 전파 필수 (§1.1 관측성) */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: process.env.SERVICE_NAME ?? 'crez' },
  redact: {
    paths: ['req.headers.authorization', '*.legalName', '*.legal_name', '*.email'],
    censor: '[redacted]',
  },
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
