'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '@/lib/api';
import { Badge, Button, Card, Empty, ErrorBox, Loading } from '@/components/ui';
import {
  GenerationSettingsFields, MODE_INFO, defaultModelFor, useModels, type GenerationSettings,
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
  const current: GenerationSettings = settings ?? {
    requiredMode: 'reference', resolution: '1080p', preferredModel: defaultModelFor(models.data, 'reference'),
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: () => get<{ items: ProjectRow[] }>('/projects?limit=50'),
  });

  const create = useMutation({
    mutationFn: () =>
      post('/projects', {
        title: title.trim(),
        projectType: type,
        config: {
          requiredMode: current.requiredMode,
          resolution: current.resolution,
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

      <ErrorBox error={error} />

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
                <div className="mt-1 text-xs text-neutral-400">{p.createdAt.slice(0, 10)}</div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
