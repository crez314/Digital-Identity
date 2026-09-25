'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '@/lib/api';
import { Badge, Button, Card, Empty, ErrorBox, Loading } from '@/components/ui';
import { useProjectEvents } from '@/hooks/use-project-events';
import { ProjectSetup, type SetupConfig } from '@/components/project-setup';
import { MODE_INFO } from '@/components/generation-settings';
import { SegmentReferences, type CastOption, type ReferenceRow } from '@/components/segment-references';
import { SEGMENT_COLORS, ms as fmtMs, score } from '@/lib/format';
import { RunProgress, type RunError } from '@/components/run-progress';

interface SegmentRow {
  id: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  status: string;
  attemptCount: number;
  latestScore: number | null;
  latestQcRunId: string | null;
  prompt: string | null;
  scenePrompt: string | null;
  lastPrompt: string | null;
  references: ReferenceRow[];
  lastReferenceIds: string[];
  lastDroppedReferenceIds: string[];
}

/**
 * 세그먼트별 프롬프트 입력.
 * 비워 두면 씬 프롬프트를 쓰고, 저장한 값은 다음 생성(재생성 포함)부터 모델에 전달된다.
 */
function SegmentPrompt({ projectId, segment, cast }: { projectId: string; segment: SegmentRow; cast: CastOption[] }) {
  const qc = useQueryClient();
  const saved = segment.prompt ?? '';
  const [draft, setDraft] = useState(saved);
  const dirty = draft.trim() !== saved;

  const save = useMutation({
    mutationFn: () => patch(`/projects/${projectId}/segments/${segment.id}`, { prompt: draft.trim() || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-segments', projectId] }),
  });

  const effective = segment.prompt ?? segment.scenePrompt;
  const inFlight = segment.status === 'GENERATING' || segment.status === 'QC';
  // 저장된 값 기준으로 비교한다 — 입력 중인 초안은 아직 생성에 쓰이지 않는다
  const promptChanged = (segment.lastPrompt ?? null) !== (effective ?? null);
  const referencesChanged =
    [...segment.lastReferenceIds].sort().join() !== segment.references.map((r) => r.id).sort().join();
  const outdated = segment.attemptCount > 0 && !inFlight && (promptChanged || referencesChanged);

  return (
    <div className="space-y-1.5">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && dirty && !save.isPending) save.mutate();
        }}
        rows={2}
        maxLength={4000}
        aria-label={`세그먼트 ${segment.segmentIndex} 프롬프트`}
        placeholder={
          segment.scenePrompt
            ? `비워 두면 씬 프롬프트 사용: ${segment.scenePrompt}`
            : '이 구간에서 만들 장면 — 인물의 동작, 카메라 구도, 조명, 분위기'
        }
        className="w-full resize-y rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="space-x-2">
          {!effective ? (
            <span className="text-amber-500">프롬프트 없음 — 모델에 빈 프롬프트가 전달됩니다</span>
          ) : !segment.prompt ? (
            <span className="text-neutral-500">씬 프롬프트 사용 중</span>
          ) : null}
          {inFlight ? <span className="text-neutral-500">진행 중인 생성에는 반영되지 않습니다</span> : null}
          {outdated ? (
            <span className="text-amber-500" title={`마지막 생성에 쓴 프롬프트: ${segment.lastPrompt ?? '(없음)'}`}>
              마지막 생성과 {promptChanged && referencesChanged ? '프롬프트·참고 이미지가' : promptChanged ? '프롬프트가' : '참고 이미지가'} 다릅니다
              — 다시 생성해야 반영됩니다
            </span>
          ) : null}
          {save.isError ? <span className="text-red-500">저장 실패: {(save.error as Error).message}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {dirty ? (
            <button type="button" className="text-neutral-500 hover:underline" onClick={() => setDraft(saved)}>
              되돌리기
            </button>
          ) : null}
          <Button variant="secondary" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? '저장 중…' : dirty ? '저장' : '저장됨'}
          </Button>
        </div>
      </div>
      <SegmentReferences
        projectId={projectId}
        segmentId={segment.id}
        references={segment.references}
        droppedIds={segment.lastDroppedReferenceIds}
        cast={cast}
      />
    </div>
  );
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

/** @crez/shared MAX_GENERATION_ATTEMPT와 같은 값 (웹은 shared를 직접 쓰지 않는다) */
const MAX_ATTEMPT = 3;

interface CostEstimate {
  segmentCount: number;
  min: number;
  max: number;
  worstCase: number;
  free: boolean;
  pinnedModel: string | null;
  spend?: {
    monthToDateKrw: number | null;
    remainingKrw: number | null;
    blocked: boolean;
    policy: { monthlyBudgetKrw: number | null };
  };
}

/** 이번 달 남은 한도. 단가가 없어 막혀 있으면 그 사실을 먼저 알린다 */
function budgetText(e: CostEstimate): string | null {
  const s = e.spend;
  if (!s) return null;
  if (s.blocked) return '크레딧 단가 미설정 — 유료 생성 차단됨';
  if (s.remainingKrw === null) return null;
  return `이번 달 ${(s.monthToDateKrw ?? 0).toLocaleString('ko-KR')}원 사용 · 남은 한도 ${s.remainingKrw.toLocaleString('ko-KR')}원`;
}

/** 모델이 고정돼 있으면 한 값, 아니면 구간으로 보여 준다 */
function costText(e: CostEstimate): string {
  const body = e.min === e.max ? `${e.max}` : `${e.min}~${e.max}`;
  return `${body} 크레딧 (재시도까지 최대 ${e.worstCase})`;
}

interface Dashboard {
  counts: Record<string, number>;
  blockers: Array<{ id: string; segmentIndex: number; startMs: number; endMs: number; attemptCount: number }>;
  blockerCount: number;
}

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => get<{ title: string; status: string; projectType: string; config: SetupConfig }>(`/projects/${id}`),
  });
  const cast = useQuery({ queryKey: ['project-cast', id], queryFn: () => get<CastRow[]>(`/projects/${id}/cast`) });
  const segments = useQuery({ queryKey: ['project-segments', id], queryFn: () => get<SegmentRow[]>(`/projects/${id}/segments`) });
  const dashboard = useQuery({ queryKey: ['project-dashboard', id], queryFn: () => get<Dashboard>(`/projects/${id}/dashboard`) });

  // 상태 변경 이벤트가 오면 목록을 다시 읽는다
  const { events, connected } = useProjectEvents(id, () => {
    qc.invalidateQueries({ queryKey: ['project-segments', id] });
    qc.invalidateQueries({ queryKey: ['project-dashboard', id] });
    qc.invalidateQueries({ queryKey: ['project', id] });
  });

  // 실행 전 견적 — 4분짜리는 구간 48개라 버튼 한 번이 수십 건의 유료 생성이다(§12.1)
  const estimate = useQuery({
    queryKey: ['generate-estimate', id],
    queryFn: () => post<CostEstimate>(`/projects/${id}/generate/estimate`, {}),
    enabled: Boolean(project.data),
  });
  // 이번 실행으로 큐에 넣은 구간 — 알림이 "무엇이 몇 개 도는지"를 이 기준으로 센다
  const [run, setRun] = useState<{ ids: string[]; at: string } | null>(null);
  // 닫으면 이번 실행에 대해서는 다시 뜨지 않는다 — 다음 실행에서 다시 연다
  const [runDismissed, setRunDismissed] = useState(false);
  const generate = useMutation({
    // 화면에 보여 준 견적을 그대로 상한으로 올려 보낸다 — 본 것과 나가는 것이 같아야 한다
    mutationFn: () => post<{ submitted: Array<{ segmentId: string }> }>(
      `/projects/${id}/generate`, { maxCost: estimate.data?.max },
    ),
    onSuccess: (res) => {
      setRun({ ids: res.submitted.map((x) => x.segmentId), at: new Date().toISOString() });
      setRunDismissed(false);
      qc.invalidateQueries({ queryKey: ['generate-estimate', id] });
      qc.invalidateQueries({ queryKey: ['project-segments', id] });
      qc.invalidateQueries({ queryKey: ['project-dashboard', id] });
    },
  });
  // 시도 한도를 다 쓴 구간은 재생성 사다리로도 못 되살린다 — 원인을 고친 뒤 되돌리는 경로
  const resetSegment = useMutation({
    mutationFn: (segmentId: string) => post(`/projects/${id}/segments/${segmentId}/reset`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-segments', id] });
      qc.invalidateQueries({ queryKey: ['project-dashboard', id] });
    },
  });
  const cancel = useMutation({ mutationFn: () => post(`/projects/${id}/cancel`) });
  const master = useMutation({ mutationFn: () => post(`/projects/${id}/master`, { normalizeColor: true, normalizeTiming: true }) });
  const remove = useMutation({
    mutationFn: () => del<{ deletedObjects: number }>(`/projects/${id}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      router.push('/projects');
    },
  });

  if (project.isLoading) return <Loading />;

  const status = project.data?.status ?? '';
  const config = project.data?.config ?? {};
  // 삭제는 실제로 도는 작업이 있을 때만 막는다(api와 같은 기준)
  const inFlight = (dashboard.data?.counts.GENERATING ?? 0) + (dashboard.data?.counts.QC ?? 0);
  // 실행 알림 — 이번 실행에 든 구간만 센다. 화면을 새로 열었으면(run 없음) 진행 중인 것만 보여 준다.
  const runSegments = (segments.data ?? []).filter((s) => !run || run.ids.includes(s.id));
  const runCount = (...st: string[]) => runSegments.filter((s) => st.includes(s.status)).length;
  const runErrors: RunError[] = run
    ? events
        .filter((e) => e.type === 'ERROR' && e.at >= run.at && (!run.ids.length || !e.segmentId || run.ids.includes(e.segmentId)))
        .map((e) => ({ code: e.payload.code as string | undefined, message: e.payload.message as string | undefined, at: e.at }))
    : [];
  // 생성 실행이 실제로 집어가는 구간 — 대기·실패이면서 시도 한도가 남은 것 (api generate와 같은 기준)
  const generatable = (segments.data ?? []).filter(
    (s) => ['PENDING', 'FAILED'].includes(s.status) && s.attemptCount < MAX_ATTEMPT,
  ).length;
  // 생성 전 단계에서만 준비 화면을 보여준다. 이후에는 캐스팅·구간을 바꿀 수 없다.
  const preparing = status === 'DRAFT' || status === 'READY';

  const confirmRemove = () => {
    const title = project.data?.title ?? '';
    if (window.confirm(`'${title}' 프로젝트를 삭제할까요?\n\n캐스팅·구간·생성 기록·결과 영상·마스터와 스토리지 파일이 모두 지워지며 되돌릴 수 없습니다. (감사 로그는 남습니다)`)) {
      remove.mutate();
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{project.data?.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <Badge className="bg-neutral-200 text-neutral-700">{status}</Badge>
            <span>{project.data?.projectType}</span>
            <span>
              {MODE_INFO[config.requiredMode ?? 'pose-guided']?.label} · {config.preferredModel ?? '자동 선택'} · {config.resolution ?? '1080p'}
            </span>
            <span className={connected ? 'text-green-600' : 'text-neutral-400'}>
              {connected ? '● 실시간 연결됨' : '○ 연결 대기'}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status === 'DRAFT' ? <span className="text-xs text-amber-500">생성 준비를 먼저 완료하세요</span> : null}
          {estimate.data && !estimate.data.free && estimate.data.segmentCount > 0 ? (
            <span className="text-xs text-neutral-600">
              예상 비용 {costText(estimate.data)} · 구간 {estimate.data.segmentCount}개
              {budgetText(estimate.data) ? <span className="ml-1 text-neutral-500">· {budgetText(estimate.data)}</span> : null}
            </span>
          ) : null}
          <Button onClick={() => generate.mutate()} disabled={generate.isPending || status === 'DRAFT' || generatable === 0}>생성 실행</Button>
          <Button variant="secondary" onClick={() => cancel.mutate()}>취소</Button>
          <Button variant="secondary" onClick={() => master.mutate()}>마스터 생성</Button>
          <Button variant="danger" onClick={confirmRemove} disabled={remove.isPending || inFlight > 0}>
            {remove.isPending ? '삭제 중…' : '프로젝트 삭제'}
          </Button>
        </div>
      </div>
      {inFlight > 0 ? (
        <p className="-mt-4 text-right text-xs text-neutral-500">생성·QC가 진행 중인 구간 {inFlight}개 — 삭제하려면 먼저 취소하세요</p>
      ) : generatable === 0 && (segments.data?.length ?? 0) > 0 ? (
        <p className="-mt-4 text-right text-xs text-neutral-500">
          생성 대기 구간이 없습니다 — 아래 구간 목록의 &lsquo;초기화&rsquo;로 되돌리거나 QC 화면에서 재생성을 요청하세요
        </p>
      ) : null}

      <ErrorBox error={generate.error ?? cancel.error ?? master.error ?? remove.error} />

      {runDismissed ? null : (
      <RunProgress
        submitted={run ? run.ids.length : null}
        running={runCount('GENERATING', 'QC')}
        passed={runCount('PASSED')}
        review={runCount('MANUAL_REVIEW')}
        failed={runCount('FAILED')}
        errors={runErrors}
        onClose={() => setRunDismissed(true)}
      />
      )}

      {preparing && cast.data && segments.data ? (
        <ProjectSetup
          projectId={id}
          projectType={project.data?.projectType ?? 'MV'}
          config={config}
          status={status}
          cast={cast.data}
          segments={segments.data}
        />
      ) : null}

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
              {segments.data.map((s) => (
                <tbody key={s.id} className="border-t border-neutral-100 dark:border-neutral-800">
                  <tr>
                    <td className="pt-3 font-mono">{s.segmentIndex}</td>
                    <td className="pt-3 font-mono text-xs">{fmtMs(s.startMs)}–{fmtMs(s.endMs)}</td>
                    <td className="pt-3"><Badge className={SEGMENT_COLORS[s.status] ?? ''}>{s.status}</Badge></td>
                    <td className="pt-3 tabular-nums">{s.attemptCount}</td>
                    <td className="pt-3 tabular-nums">{score(s.latestScore)}</td>
                    <td className="pt-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {['FAILED', 'MANUAL_REVIEW'].includes(s.status) ? (
                          <button
                            type="button"
                            onClick={() => resetSegment.mutate(s.id)}
                            disabled={resetSegment.isPending}
                            className="text-xs text-neutral-500 hover:underline disabled:opacity-40"
                            title="시도 횟수를 0으로 되돌려 다시 생성할 수 있게 합니다 (생성 기록은 남습니다)"
                          >
                            초기화
                          </button>
                        ) : null}
                        {s.latestQcRunId ? (
                          <Link href={`/qc-runs/${s.latestQcRunId}`} className="text-xs text-blue-600 hover:underline">
                            QC 보기
                          </Link>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td />
                    <td colSpan={5} className="pb-3 pt-2">
                      {/* 저장된 값이 바뀌면(저장 후 재조회) 초안을 서버 값으로 다시 맞춘다 */}
                      <SegmentPrompt key={`${s.id}:${s.prompt ?? ''}`} projectId={id} segment={s} cast={cast.data ?? []} />
                    </td>
                  </tr>
                </tbody>
              ))}
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
                      <span className="mr-2 text-xs text-neutral-500">위치 {c.slotIndex + 1}</span>
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
