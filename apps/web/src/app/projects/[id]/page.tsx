'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { use } from 'react';
import { get, post } from '@/lib/api';
import { Badge, Button, Card, Empty, ErrorBox, Loading } from '@/components/ui';
import { useProjectEvents } from '@/hooks/use-project-events';
import { SEGMENT_COLORS, ms as fmtMs, score } from '@/lib/format';

interface SegmentRow {
  id: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  status: string;
  attemptCount: number;
  latestScore: number | null;
  latestQcRunId: string | null;
}

interface CastRow {
  id: string;
  identityId: string;
  identityCode: string;
  displayName: string;
  profileVersion: number;
  slotIndex: number;
  roleLabel: string | null;
}

interface Dashboard {
  counts: Record<string, number>;
  blockers: Array<{ id: string; segmentIndex: number; startMs: number; endMs: number; attemptCount: number }>;
  blockerCount: number;
}

export default function ProjectDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();

  const project = useQuery({ queryKey: ['project', id], queryFn: () => get<{ title: string; status: string; projectType: string }>(`/projects/${id}`) });
  const cast = useQuery({ queryKey: ['project-cast', id], queryFn: () => get<CastRow[]>(`/projects/${id}/cast`) });
  const segments = useQuery({ queryKey: ['project-segments', id], queryFn: () => get<SegmentRow[]>(`/projects/${id}/segments`) });
  const dashboard = useQuery({ queryKey: ['project-dashboard', id], queryFn: () => get<Dashboard>(`/projects/${id}/dashboard`) });

  // 상태 변경 이벤트가 오면 목록을 다시 읽는다
  const { events, connected } = useProjectEvents(id, () => {
    qc.invalidateQueries({ queryKey: ['project-segments', id] });
    qc.invalidateQueries({ queryKey: ['project-dashboard', id] });
    qc.invalidateQueries({ queryKey: ['project', id] });
  });

  const generate = useMutation({ mutationFn: () => post(`/projects/${id}/generate`, {}) });
  const cancel = useMutation({ mutationFn: () => post(`/projects/${id}/cancel`) });
  const master = useMutation({ mutationFn: () => post(`/projects/${id}/master`, { normalizeColor: true, normalizeTiming: true }) });

  if (project.isLoading) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{project.data?.title}</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
            <Badge className="bg-neutral-200 text-neutral-700">{project.data?.status}</Badge>
            <span>{project.data?.projectType}</span>
            <span className={connected ? 'text-green-600' : 'text-neutral-400'}>
              {connected ? '● 실시간 연결됨' : '○ 연결 대기'}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => generate.mutate()} disabled={generate.isPending}>생성 실행</Button>
          <Button variant="secondary" onClick={() => cancel.mutate()}>취소</Button>
          <Button variant="secondary" onClick={() => master.mutate()}>마스터 생성</Button>
        </div>
      </div>

      <ErrorBox error={generate.error ?? cancel.error ?? master.error} />

      {/* §5.2 MANUAL_REVIEW 블로커 표시 */}
      {dashboard.data?.blockerCount ? (
        <div className="rounded border border-violet-300 bg-violet-50 p-4 dark:border-violet-800 dark:bg-violet-950">
          <div className="font-medium text-violet-900 dark:text-violet-200">
            수동 검토 대기 {dashboard.data.blockerCount}건 — 프로젝트가 완료되지 않습니다
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {dashboard.data.blockers.map((b) => (
              <span key={b.id} className="rounded bg-violet-200 px-2 py-1 font-mono text-violet-900">
                #{b.segmentIndex} {fmtMs(b.startMs)}–{fmtMs(b.endMs)} ({b.attemptCount}회)
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-3 font-medium">세그먼트 ({segments.data?.length ?? 0})</h2>
          {!segments.data?.length ? (
            <Empty label="씬/세그먼트가 정의되지 않았습니다" />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-neutral-500">
                <tr><th className="py-1">#</th><th>구간</th><th>상태</th><th>시도</th><th>점수</th><th /></tr>
              </thead>
              <tbody>
                {segments.data.map((s) => (
                  <tr key={s.id} className="border-t border-neutral-100 dark:border-neutral-800">
                    <td className="py-2 font-mono">{s.segmentIndex}</td>
                    <td className="font-mono text-xs">{fmtMs(s.startMs)}–{fmtMs(s.endMs)}</td>
                    <td><Badge className={SEGMENT_COLORS[s.status] ?? ''}>{s.status}</Badge></td>
                    <td className="tabular-nums">{s.attemptCount}</td>
                    <td className="tabular-nums">{score(s.latestScore)}</td>
                    <td className="text-right">
                      {s.latestQcRunId ? (
                        <Link href={`/qc-runs/${s.latestQcRunId}`} className="text-xs text-blue-600 hover:underline">
                          QC 보기
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <h2 className="mb-3 font-medium">캐스트</h2>
            {!cast.data?.length ? (
              <Empty label="캐스팅 전" />
            ) : (
              <ul className="space-y-2 text-sm">
                {cast.data.map((c) => (
                  <li key={c.id} className="flex items-center justify-between">
                    <span>
                      <span className="font-mono text-xs text-neutral-500">{c.identityCode}</span>{' '}
                      {c.displayName}
                    </span>
                    <span className="text-xs text-neutral-400">프로파일 v{c.profileVersion}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 font-medium">실시간 이벤트</h2>
            {!events.length ? (
              <div className="text-xs text-neutral-400">아직 이벤트가 없습니다</div>
            ) : (
              <ul className="max-h-72 space-y-1 overflow-auto text-xs">
                {events.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="border-b border-neutral-100 pb-1 dark:border-neutral-800">
                    <span className="font-mono text-neutral-400">{e.at.slice(11, 19)}</span>{' '}
                    <span className="font-medium">{e.type}</span>{' '}
                    <span className="text-neutral-500">{JSON.stringify(e.payload).slice(0, 120)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
