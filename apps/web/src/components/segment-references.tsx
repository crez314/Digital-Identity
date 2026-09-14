'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { del, post } from '@/lib/api';
import { uploadViaPresignedUrl } from '@/lib/upload';

type Kind = 'BACKGROUND' | 'OUTFIT' | 'HAIR';

export interface ReferenceRow {
  id: string;
  kind: Kind;
  slotIndex: number | null;
  fileName: string;
  previewUrl: string | null;
}

export interface CastOption {
  slotIndex: number;
  displayName: string;
}

const KIND_LABEL: Record<Kind, string> = { BACKGROUND: '배경', OUTFIT: '의상', HAIR: '헤어' };
const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];
/** Higgsfield Veo reference-to-video의 image_urls 상한 — 인물 얼굴과 나눠 쓴다 */
const VEO_REFERENCE_MAX = 3;
const selectCls =
  'rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100';

/**
 * 세그먼트 프롬프트에 붙이는 참고 이미지(배경·의상·헤어).
 * 저장한 이미지는 다음 생성부터 인물 레퍼런스와 함께 모델에 전달되며, 한도를 넘어 빠진 이미지는 표시한다.
 */
export function SegmentReferences({
  projectId, segmentId, references, droppedIds, cast,
}: {
  projectId: string;
  segmentId: string;
  references: ReferenceRow[];
  droppedIds: string[];
  cast: CastOption[];
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>('BACKGROUND');
  const [slot, setSlot] = useState(''); // '' = 전원 공통
  const refresh = () => qc.invalidateQueries({ queryKey: ['project-segments', projectId] });
  const base = `/projects/${projectId}/segments/${segmentId}/references`;

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        if (!ACCEPT.includes(file.type)) throw new Error(`${file.name}: JPG·PNG·WEBP만 첨부할 수 있습니다`);
        await uploadViaPresignedUrl({
          file, contentType: file.type,
          requestUrl: async () => {
            const r = await post<{ referenceId: string; uploadUrl: string }>(`${base}/upload-url`, {
              kind,
              slotIndex: kind === 'BACKGROUND' || slot === '' ? null : Number(slot),
              contentType: file.type,
              fileName: file.name,
            });
            return { id: r.referenceId, uploadUrl: r.uploadUrl };
          },
          confirm: (referenceId, checksum) => post(`${base}/${referenceId}/confirm`, { checksum }),
        });
      }
    },
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: (referenceId: string) => del(`${base}/${referenceId}`),
    onSuccess: refresh,
  });

  const nameOf = (slotIndex: number | null) =>
    slotIndex === null ? '전원' : `위치 ${slotIndex + 1}${cast.find((c) => c.slotIndex === slotIndex) ? ` ${cast.find((c) => c.slotIndex === slotIndex)?.displayName}` : ' (캐스트 없음)'}`;
  const room = Math.max(0, VEO_REFERENCE_MAX - cast.length);

  return (
    <div className="rounded border border-dashed border-neutral-300 px-3 py-2 dark:border-neutral-700">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-neutral-500">참고 이미지</span>
        <select aria-label="참고 이미지 종류" value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={selectCls}>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select
          aria-label="참고 이미지 대상"
          value={kind === 'BACKGROUND' ? '' : slot}
          disabled={kind === 'BACKGROUND'}
          onChange={(e) => setSlot(e.target.value)}
          className={selectCls}
        >
          <option value="">{kind === 'BACKGROUND' ? '장면 전체' : '전원 공통'}</option>
          {cast.map((c) => <option key={c.slotIndex} value={c.slotIndex}>위치 {c.slotIndex + 1} · {c.displayName}</option>)}
        </select>
        <label
          className={`rounded border border-neutral-300 px-2 py-1 font-medium dark:border-neutral-700 ${
            upload.isPending ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800'
          }`}
        >
          {upload.isPending ? '올리는 중…' : '파일 첨부'}
          <input
            type="file"
            accept={ACCEPT.join(',')}
            multiple
            className="hidden"
            disabled={upload.isPending}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) upload.mutate(files);
            }}
          />
        </label>
        <span className="text-neutral-500">
          다음 생성부터 인물 사진과 함께 모델에 전달됩니다 · Veo는 이미지 {VEO_REFERENCE_MAX}장까지 받아 인물 {cast.length}명의 얼굴을 먼저 넣고 첨부는 {room}장까지 들어갑니다
        </span>
      </div>

      {references.length ? (
        <ul className="mt-2 flex flex-wrap gap-3">
          {references.map((r) => (
            <li key={r.id} className="relative w-20 text-center text-[10px]" title={r.fileName}>
              <button
                type="button"
                aria-label={`${KIND_LABEL[r.kind]} 참고 이미지 삭제`}
                onClick={() => remove.mutate(r.id)}
                disabled={remove.isPending}
                className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 text-xs leading-none text-white ring-1 ring-neutral-500 hover:bg-red-600 disabled:opacity-40"
              >
                ×
              </button>
              {/* presigned URL은 만료되는 외부 주소라 next/image 최적화 대상이 아니다 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.previewUrl ?? ''} alt={`${KIND_LABEL[r.kind]} 참고 이미지`} className="h-20 w-20 rounded object-cover" />
              <div className="mt-1 font-medium">{KIND_LABEL[r.kind]}</div>
              <div className="truncate text-neutral-500">{r.kind === 'BACKGROUND' ? '장면 전체' : nameOf(r.slotIndex)}</div>
              {droppedIds.includes(r.id) ? <div className="text-amber-500">지난 생성에 미전달</div> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {upload.error || remove.error ? (
        <p className="mt-1 text-xs text-red-500">{((upload.error ?? remove.error) as Error).message}</p>
      ) : null}
    </div>
  );
}
