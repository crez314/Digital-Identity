/** 비용에 영향을 주는 입력이 바뀌면 이전 견적을 실행 상한으로 재사용하지 않는다. */
export function generationEstimateKey(projectId: string, config: unknown,
  segments?: Array<{ id: string; status: string; attemptCount: number; startMs: number; endMs: number }>) {
  return ['generate-estimate', projectId, config, segments?.map((s) =>
    [s.id, s.status, s.attemptCount, s.startMs, s.endMs])] as const;
}

type Event = {
  type: string; traceId?: string; segmentId?: string; at: string; payload: Record<string, unknown>;
};

/** 응답보다 먼저 온 오류도 실행 traceId로 찾는다. 클라이언트/서버 시계 차이에 의존하지 않는다. */
export function generationRunErrors(events: Event[], run: { ids: string[]; traceId: string } | null) {
  if (!run) return [];
  return events.filter((e) => e.type === 'ERROR' && e.traceId === run.traceId
    && (!e.segmentId || run.ids.includes(e.segmentId)))
    .map((e) => ({
      code: e.payload.code as string | undefined,
      message: (e.payload.message ?? e.payload.detail) as string | undefined,
      at: e.at,
      // 정책 거부는 자동 재제출로 이어질 수 있다 — 그 사이를 '실패'로 보여 주면 사람이 손을 댄다
      retrying: (e.payload.policyRetry as { retrying?: boolean } | undefined)?.retrying === true,
    }));
}
