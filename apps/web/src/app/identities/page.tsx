'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { del, get, post } from '@/lib/api';
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
  const [nameMissing, setNameMissing] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['identities'],
    queryFn: () => get<{ items: IdentityRow[] }>('/identities?limit=50'),
  });

  const create = useMutation({
    mutationFn: (displayName: string) => post('/identities', { displayName }),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['identities'] });
    },
  });

  // 목록에서 바로 삭제. 캐스팅된 인물은 서버가 어느 프로젝트인지 알려주며 거절한다.
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => del<{ deletedObjects: number }>(`/identities/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['identities'] });
      qc.invalidateQueries({ queryKey: ['identities-all'] });
    },
    onSettled: () => setRemoving(null),
  });

  // 카드 전체가 링크라 삭제 버튼 클릭이 상세 화면으로 이동하지 않게 막는다
  function confirmRemove(e: React.MouseEvent, i: IdentityRow) {
    e.preventDefault();
    e.stopPropagation();
    const ok = window.confirm(
      `'${i.code} ${i.displayName}'을(를) 삭제할까요?\n\n`
      + '등록한 사진·임베딩·프로파일·권리 기록과 스토리지 파일이 모두 지워지며 되돌릴 수 없습니다. (감사 로그는 남습니다)',
    );
    if (!ok) return;
    setRemoving(i.id);
    remove.mutate(i.id);
  }

  // 버튼을 비활성화해 두면 왜 눌리지 않는지 알 수 없다 — 누르게 두고 빠진 입력을 알려준다.
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const displayName = name.trim();
    if (!displayName) {
      setNameMissing(true);
      nameInput.current?.focus();
      return;
    }
    create.mutate(displayName);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Identity 라이브러리</h1>
          <p className="mt-1 text-sm text-neutral-500">
            등록된 인물과 프로파일 버전. code는 미지정 시 CRZ-Annn으로 자동 발번된다.
          </p>
        </div>
        <form onSubmit={submit} className="flex flex-col items-end gap-1">
          <div className="flex gap-2">
            <input
              ref={nameInput}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameMissing(false);
              }}
              placeholder="표시명"
              aria-label="표시명"
              aria-invalid={nameMissing}
              className={`rounded border px-3 py-1.5 text-sm dark:bg-neutral-900 ${
                nameMissing ? 'border-red-500' : 'border-neutral-300 dark:border-neutral-700'
              }`}
            />
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? '생성 중…' : 'Identity 생성'}
            </Button>
          </div>
          {nameMissing ? <p className="text-xs text-red-500">표시명을 입력하세요</p> : null}
        </form>
      </div>

      <ErrorBox error={create.error ?? remove.error ?? error} />

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
                <div className="mt-3 flex items-end justify-between gap-2 text-xs text-neutral-500">
                  <span>
                    {i.activeProfile ? (
                      <>
                        프로파일 v{i.activeProfile.version} · 산포 {score(i.activeProfile.faceVariance)}
                      </>
                    ) : (
                      '활성 프로파일 없음'
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => confirmRemove(e, i)}
                    disabled={removing === i.id}
                    aria-label={`${i.code} ${i.displayName} 삭제`}
                    className="shrink-0 rounded px-1.5 py-0.5 text-neutral-400 transition hover:bg-red-600 hover:text-white disabled:opacity-40"
                  >
                    {removing === i.id ? '삭제 중…' : '삭제'}
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
