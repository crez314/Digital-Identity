import { randomUUID } from 'node:crypto';

/** job payload와 HTTP 요청 사이에 전파되는 trace ID (§8) */
export function newTraceId(): string {
  return randomUUID();
}

export interface TraceContext {
  traceId: string;
  projectId?: string;
  segmentId?: string;
  attempt?: number;
}
