import { describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { generationEstimateKey, generationRunErrors } from './generation-state';

describe('생성 실행 화면', () => {
  it('구간 구성·초기화·모델 변경 후 새 견적을 조회한다', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
    let cost = 0;
    let calls = 0;
    const queryFn = async () => { calls++; return { max: cost }; };
    const observer = new QueryObserver(client, { queryKey: generationEstimateKey('p', {}, []), queryFn });
    const unsub = observer.subscribe(() => {});
    await observer.refetch();
    const segments = [{ id: 's', status: 'PENDING', attemptCount: 0, startMs: 0, endMs: 5000 }];
    cost = 6;
    observer.setOptions({ queryKey: generationEstimateKey('p', {}, segments), queryFn });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observer.getCurrentResult().data?.max).toBe(6);
    const before = calls;
    cost = 10;
    observer.setOptions({ queryKey: generationEstimateKey('p', { preferredModel: 'other' }, segments), queryFn });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observer.getCurrentResult().data?.max).toBe(10);
    expect(calls).toBeGreaterThan(before);
    expect(generationEstimateKey('p', {}, segments)).not.toEqual(
      generationEstimateKey('p', {}, [{ ...segments[0], status: 'FAILED', attemptCount: 3 }]),
    );
    unsub(); client.clear();
  });

  it('응답 전 오류와 서버 시계가 느린 오류도 현재 실행에 표시한다', () => {
    const event = { type: 'ERROR', traceId: 'current', segmentId: 's',
      at: '2020-01-01T00:00:00Z', payload: { detail: '한도 초과' } };
    expect(generationRunErrors([event, { ...event, traceId: 'previous' }], { ids: ['s'], traceId: 'current' }))
      .toEqual([{ code: undefined, message: '한도 초과', at: event.at, retrying: false }]);
  });

  it('정책 거부에 자동 재시도가 걸린 오류는 재시도 중으로 표시한다', () => {
    const event = { type: 'ERROR', traceId: 'current', segmentId: 's', at: '2020-01-01T00:00:00Z',
      payload: { code: 'CREZ-GEN-003', detail: 'nsfw로 거부됨', policyRetry: { retrying: true, rejections: 1, attempt: 2 } } };
    expect(generationRunErrors([event], { ids: ['s'], traceId: 'current' })[0].retrying).toBe(true);
  });
});
