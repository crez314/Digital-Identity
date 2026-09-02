'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post } from '@/lib/api';
import { Badge, Button, Card, Empty, ErrorBox, Loading } from '@/components/ui';
import { score } from '@/lib/format';

interface IdentityRow {
  id: string;
  code: string;
  displayName: string;
  status: string;
  createdAt: string;
  activeProfile: { version: number; status: string; faceVariance: number | null } | null;
}

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-neutral-200 text-neutral-700',
  ACTIVE: 'bg-green-100 text-green-800',
  SUSPENDED: 'bg-amber-100 text-amber-800',
  ARCHIVED: 'bg-neutral-300 text-neutral-600',
};

export default function IdentitiesPage() {
  const qc = useQueryClient();
  const [name, setName] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['identities'],
    queryFn: () => get<{ items: IdentityRow[] }>('/identities?limit=50'),
  });

  const create = useMutation({
    mutationFn: () => post('/identities', { displayName: name }),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['identities'] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Identity 라이브러리</h1>
          <p className="mt-1 text-sm text-neutral-500">
            등록된 인물과 프로파일 버전. code는 미지정 시 CRZ-Annn으로 자동 발번된다.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="표시명"
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <Button onClick={() => create.mutate()} disabled={!name || create.isPending}>
            Identity 생성
          </Button>
        </div>
      </div>

      <ErrorBox error={create.error ?? error} />

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Empty label="등록된 Identity가 없습니다" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((i) => (
            <Link key={i.id} href={`/identities/${i.id}`}>
              <Card className="transition hover:border-neutral-400">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-neutral-500">{i.code}</span>
                  <Badge className={STATUS_STYLE[i.status] ?? ''}>{i.status}</Badge>
                </div>
                <div className="mt-2 text-lg font-medium">{i.displayName}</div>
                <div className="mt-3 text-xs text-neutral-500">
                  {i.activeProfile ? (
                    <>
                      프로파일 v{i.activeProfile.version} · 산포 {score(i.activeProfile.faceVariance)}
                    </>
                  ) : (
                    '활성 프로파일 없음'
                  )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
