'use client';

import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/api';

export interface ProjectEvent {
  type: string;
  projectId: string;
  segmentId?: string;
  payload: Record<string, unknown>;
  at: string;
  traceId?: string;
}

/** §6.3 SSE — 진행률·상태 변경 실시간 스트림 */
export function useProjectEvents(projectId: string, onEvent?: (e: ProjectEvent) => void) {
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource(`${apiBase}/projects/${projectId}/events`, { withCredentials: false });
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as ProjectEvent;
        if (parsed.type === 'HEARTBEAT') return;
        setEvents((prev) => [parsed, ...prev].slice(0, 100));
        onEvent?.(parsed);
      } catch {
        // 무시 — 스트림 손상이 화면을 죽이면 안 된다
      }
    };
    return () => source.close();
    // onEvent를 의존성에 넣으면 매 렌더마다 재연결된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return { events, connected };
}
