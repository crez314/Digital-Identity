import { createHash } from 'node:crypto';
import type {
  FetchResult, GenerationProvider, GenerationRequest, ModelDescriptor, PollResult, SubmitResult,
} from '../types';

/**
 * 개발/테스트용 어댑터 (§18).
 * 실제 생성 대신 결정론적 지연 후 성공을 반환한다. GPU·외부 계약 없이
 * 전체 파이프라인(생성 → QC → 재생성 → 마스터)을 돌리기 위한 것.
 */
interface MockJob {
  startedAt: number;
  durationMs: number;
  req: GenerationRequest;
  fail: boolean;
  cancelled: boolean;
}

const jobs = new Map<string, MockJob>();

/** seed 기반 결정론적 실패 — 재시도 경로를 테스트할 수 있게 한다. */
function shouldFail(req: GenerationRequest): boolean {
  if (process.env.GEN_MOCK_FAILURE_RATE === '0') return false;
  const rate = Number(process.env.GEN_MOCK_FAILURE_RATE ?? '0');
  if (rate <= 0) return false;
  const h = createHash('sha256').update(`${req.segmentId}:${req.attempt}`).digest();
  return h.readUInt16BE(0) / 65535 < rate;
}

export class MockProvider implements GenerationProvider {
  readonly code = 'mock';

  async submit(req: GenerationRequest): Promise<SubmitResult> {
    const providerJobId = `mock_${req.segmentId}_${req.attempt}`;
    jobs.set(providerJobId, {
      startedAt: Date.now(),
      durationMs: Number(process.env.GEN_MOCK_LATENCY_MS ?? 1500),
      req,
      fail: shouldFail(req),
      cancelled: false,
    });
    return { providerJobId };
  }

  async poll(providerJobId: string): Promise<PollResult> {
    const job = jobs.get(providerJobId);
    if (!job) return { state: 'FAILED', progress: 0, errorCode: 'CREZ-GEN-002', errorDetail: 'unknown job' };
    if (job.cancelled) return { state: 'CANCELLED', progress: 0 };
    const elapsed = Date.now() - job.startedAt;
    if (elapsed < job.durationMs) {
      return { state: 'RUNNING', progress: Math.min(0.99, elapsed / job.durationMs), nextPollMs: 500 };
    }
    if (job.fail) {
      return { state: 'FAILED', progress: 1, errorCode: 'CREZ-GEN-002', errorDetail: 'mock deterministic failure' };
    }
    return { state: 'SUCCEEDED', progress: 1 };
  }

  async fetchResult(providerJobId: string, req: GenerationRequest, model: ModelDescriptor): Promise<FetchResult> {
    const height = req.resolution;
    const width = Math.round((height * 16) / 9);
    return {
      storageKey: req.outputKey,
      durationMs: req.durationMs,
      fps: req.fps,
      width,
      height,
      costAmount: this.estimateCost(req, model),
    };
  }

  async cancel(providerJobId: string): Promise<void> {
    const job = jobs.get(providerJobId);
    if (job) job.cancelled = true;
  }

  estimateCost(req: GenerationRequest, model: ModelDescriptor): number {
    return Number(((req.durationMs / 1000) * (model.costPerSecond || 0)).toFixed(4));
  }
}
