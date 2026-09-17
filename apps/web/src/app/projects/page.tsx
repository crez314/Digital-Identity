'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '@/lib/api';
import { Badge, Button, Card, Empty, ErrorBox, Loading } from '@/components/ui';
import {
  GenerationSettingsFields, MODE_INFO, defaultMode, defaultModelFor, useModels, type GenerationSettings,
} from '@/components/generation-settings';

interface ProjectRow {
  id: string;
  title: string;
  projectType: string;
  status: string;
  config: { requiredMode?: string; preferredModel?: string; resolution?: string };
  createdAt: string;
}

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-neutral-200 text-neutral-700',
  READY: 'bg-blue-100 text-blue-800',
  RUNNING: 'bg-amber-100 text-amber-800',
  REVIEW: 'bg-violet-100 text-violet-800',
  COMPLETED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-700',
};

export default function ProjectsPage() {
  const qc = useQueryClient();
  const models = useModels();
  const [title, setTitle] = useState('');
  const [type, setType] = useState('MV');
  // 모델 목록이 오기 전에는 null — 도착하면 인물 레퍼런스 방식의 실제 모델을 기본으로 잡는다
  const [settings, setSettings] = useState<GenerationSettings | null>(null);
  // 쓸 수 있는 모델이 있는 방식을 기본값으로 잡는다 — 모델 목록이 도착하면 다시 계산된다
  const startMode = defaultMode(models.data);
  const current: GenerationSettings = settings ?? {
    requiredMode: startMode, resolution: '1080p', aspectRatio: '16:9',
    preferredModel: defaultModelFor(models.data, startMode),
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: () => get<{ items: ProjectRow[] }>('/projects?limit=50'),
  });

  // 목록에서 바로 삭제. 생성·QC가 진행 중인 구간이 있으면 서버가 거절한다(먼저 취소해야 한다).
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => del<{ deletedObjects: number }>(`/projects/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
    onSettled: () => setRemoving(null),
  });

  // 카드 전체가 링크라 삭제 버튼 클릭이 상세 화면으로 이동하지 않게 막는다
  function confirmRemove(e: React.MouseEvent, p: ProjectRow) {
    e.preventDefault();
    e.stopPropagation();
    const ok = window.confirm(
      `'${p.title}' 프로젝트를 삭제할까요?\n\n`
      + '캐스팅·구간·생성 기록·결과 영상·마스터와 스토리지 파일이 모두 지워지며 되돌릴 수 없습니다. (감사 로그는 남습니다)',
    );
    if (!ok) return;
    setRemoving(p.id);
    remove.mutate(p.id);
  }

  const create = useMutation({
    mutationFn: () =>
      post('/projects', {
        title: title.trim(),
        projectType: type,
        config: {
          requiredMode: current.requiredMode,
          resolution: current.resolution,
          aspectRatio: current.aspectRatio,
          ...(current.preferredModel ? { preferredModel: current.preferredModel } : {}),
        },
      }),
    onSuccess: () => {
      setTitle('');
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">프로젝트</h1>

      <Card>
        <h2 className="font-medium">새 프로젝트</h2>
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <label className="text-xs text-neutral-500">
              제목
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 김지민 MV 테스트"
                className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
            </label>
            <label className="text-xs text-neutral-500">
              유형
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              >
                {['MV', 'CONCERT', 'AD', 'SHORTS'].map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
          </div>
          <GenerationSettingsFields value={current} onChange={setSettings} />
          <ErrorBox error={create.error} />
          <div className="flex justify-end">
            <Button type="submit" disabled={!title.trim() || create.isPending}>
              {create.isPending ? '만드는 중…' : '프로젝트 생성'}
            </Button>
          </div>
        </form>
      </Card>

      <ErrorBox error={remove.error ?? error} />

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Empty label="프로젝트가 없습니다" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`}>
              <Card className="transition hover:border-neutral-400">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-neutral-500">{p.projectType}</span>
                  <Badge className={STATUS_STYLE[p.status] ?? ''}>{p.status}</Badge>
                </div>
                <div className="mt-2 font-medium">{p.title}</div>
                <div className="mt-2 truncate text-xs text-neutral-500">
                  {MODE_INFO[p.config?.requiredMode ?? 'pose-guided']?.label ?? p.config?.requiredMode}
                  {' · '}
                  {p.config?.preferredModel ?? '자동 선택'}
                </div>
                <div className="mt-1 flex items-end justify-between gap-2 text-xs text-neutral-400">
                  <span>{p.createdAt.slice(0, 10)}</span>
                  <button
                    type="button"
                    onClick={(e) => confirmRemove(e, p)}
                    disabled={removing === p.id}
                    aria-label={`${p.title} 삭제`}
                    className="shrink-0 rounded px-1.5 py-0.5 transition hover:bg-red-600 hover:text-white disabled:opacity-40"
                  >
                    {removing === p.id ? '삭제 중…' : '삭제'}
                  </button>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
