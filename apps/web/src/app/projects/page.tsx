'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '@/lib/api';
import { Badge, Button, Card, Empty, ErrorBox, Loading } from '@/components/ui';

interface ProjectRow {
  id: string;
  title: string;
  projectType: string;
  status: string;
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
  const [title, setTitle] = useState('');
  const [type, setType] = useState('MV');

  const { data, isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: () => get<{ items: ProjectRow[] }>('/projects?limit=50'),
  });

  const create = useMutation({
    mutationFn: () => post('/projects', { title, projectType: type }),
    onSuccess: () => {
      setTitle('');
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <h1 className="text-xl font-semibold">프로젝트</h1>
        <div className="flex gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="제목"
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="rounded border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {['MV', 'CONCERT', 'AD', 'SHORTS'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <Button onClick={() => create.mutate()} disabled={!title || create.isPending}>
            생성
          </Button>
        </div>
      </div>

      <ErrorBox error={create.error ?? error} />

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
                <div className="mt-2 text-xs text-neutral-400">{p.createdAt.slice(0, 10)}</div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
