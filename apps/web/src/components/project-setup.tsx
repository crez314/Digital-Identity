'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, put } from '@/lib/api';
import { Badge, Button, Card, ErrorBox } from '@/components/ui';
import {
  GenerationSettingsFields, MODE_INFO, capableModels, defaultModelFor, useModels, type GenerationSettings,
} from '@/components/generation-settings';

interface IdentityRow {
  id: string;
  code: string;
  displayName: string;
  status: string;
  activeProfile: { version: number } | null;
}

interface RightsRow {
  consentStatus: string;
  allowedUsage: string[];
  restrictedUsage: string[];
  syntheticPermitted: boolean;
  expiresAt: string | null;
}

export interface SetupCast { identityId: string; slotIndex: number }
export interface SetupSegment {
  startMs: number;
  endMs: number;
  attemptCount: number;
  prompt: string | null;
  scenePrompt: string | null;
  references: unknown[];
}

/** 캐스팅은 이 상태에서만 바꿀 수 있다(§6.3) — api와 같은 조건 */
const CAST_LOCKED = ['RUNNING', 'COMPLETED', 'ARCHIVED'];

/**
 * 캐스팅 불가 사유를 미리 보여준다. 최종 판정은 서버의 권리 게이트(§14.1)가 하며,
 * 여기서는 선택 전에 이유를 알 수 있도록 명백한 경우만 거른다.
 */
function castBlocker(identity: IdentityRow, rights: RightsRow | null | undefined, usageType: string): string | null {
  if (!identity.activeProfile) return '활성 프로파일 없음 — 사진 업로드 후 프로파일 빌드';
  if (rights === undefined) return null; // 조회 중
  if (!rights) return '권리 정보 미등록';
  if (rights.consentStatus !== 'GRANTED') return `동의 상태 ${rights.consentStatus}`;
  if (!rights.syntheticPermitted) return '합성 콘텐츠 생성 미허용';
  if (rights.expiresAt && new Date(rights.expiresAt) < new Date()) return '계약 만료';
  if (rights.restrictedUsage.includes(usageType)) return `${usageType} 제한 용도`;
  if (rights.allowedUsage.length > 0 && !rights.allowedUsage.includes(usageType)) {
    return `허용 용도에 ${usageType} 없음 (${rights.allowedUsage.join(', ')})`;
  }
  return null;
}

export interface SetupConfig {
  requiredMode?: string;
  resolution?: string;
  aspectRatio?: string;
  /** 소리(음악·효과음)를 함께 생성할지. 없으면 켠 것으로 본다 */
  audio?: boolean;
  preferredModel?: string;
}

/** SetCastRequest 상한 */
const MAX_CAST = 10;
const selectCls =
  'rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100';

/**
 * 위치별 캐스팅. 인원수만큼 위치 1부터 슬롯을 만들고, 슬롯마다 라이브러리의 인물을 고른다.
 * 위치 순서(slotIndex)대로 인물과 레퍼런스 이미지가 생성 모델에 전달된다.
 */
function CastEditor({
  projectId, projectType, requiredMode, preferredModel, status, cast,
}: {
  projectId: string; projectType: string; requiredMode: string; preferredModel: string | null; status: string; cast: SetupCast[];
}) {
  const qc = useQueryClient();
  const identities = useQuery({
    queryKey: ['identities-all'],
    queryFn: () => get<{ items: IdentityRow[] }>('/identities?limit=100'),
  });
  const items = identities.data?.items ?? [];
  const rightsQueries = useQueries({
    queries: items.map((i) => ({
      queryKey: ['identity-rights', i.id],
      queryFn: () => get<RightsRow | null>(`/identities/${i.id}/rights`),
    })),
  });
  const rightsById = new Map(items.map((i, k) => [i.id, rightsQueries[k]?.data]));
  const blockerOf = (identity: IdentityRow) => castBlocker(identity, rightsById.get(identity.id), projectType);

  // 인원 한도는 모델마다 다르다 — 모델을 지정했으면 그 모델, 아니면 이 방식을 지원하는 활성 모델 중 가장 큰 값
  const models = useModels();
  const capable = capableModels(models.data, requiredMode);
  const pinned = capable.find((m) => m.code === preferredModel);
  const maxPersons = pinned
    ? pinned.capabilities.maxPersons
    : capable.length ? Math.max(...capable.map((m) => m.capabilities.maxPersons)) : 0;
  const basis = pinned ? `지정 모델 ${pinned.code}` : `활성 모델(${requiredMode} 방식)`;

  const initial = [...cast].sort((a, b) => a.slotIndex - b.slotIndex).map((c) => c.identityId);
  const [slots, setSlots] = useState<string[]>(initial.length ? initial : ['']);
  const locked = CAST_LOCKED.includes(status);
  const dirty = slots.join() !== initial.join();
  const empty = slots.findIndex((s) => !s);

  const setCount = (n: number) =>
    setSlots((prev) => (n > prev.length ? [...prev, ...new Array<string>(n - prev.length).fill('')] : prev.slice(0, n)));
  const choose = (i: number, identityId: string) => setSlots((prev) => prev.map((s, j) => (j === i ? identityId : s)));

  const save = useMutation({
    mutationFn: () =>
      put(`/projects/${projectId}/cast`, {
        cast: slots.map((identityId, slotIndex) => ({ identityId, slotIndex })),
        usageType: projectType,
      }),
    onSuccess: () => {
      for (const key of ['project-cast', 'project', 'project-segments']) qc.invalidateQueries({ queryKey: [key, projectId] });
    },
  });

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        인원수를 정하면 위치 1부터 순서대로 자리가 생깁니다. 자리마다 라이브러리에 등록된 인물을 고르세요 —
        이 순서대로 인물과 레퍼런스 이미지가 생성 모델에 전달됩니다. 모델은 화면 속 배치를 스스로 알지 못하므로,
        왼쪽·오른쪽 같은 배치는 구간 프롬프트에 인물 특징과 함께 적어야 합니다.
      </p>
      {locked ? <p className="text-xs text-amber-500">{status} 상태에서는 캐스팅을 바꿀 수 없습니다.</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          인원수
          <select
            aria-label="인원수"
            value={slots.length}
            disabled={locked}
            onChange={(e) => setCount(Number(e.target.value))}
            className={selectCls}
          >
            {Array.from({ length: MAX_CAST }, (_, k) => k + 1).map((n) => (
              <option key={n} value={n}>{n}명</option>
            ))}
          </select>
        </label>
        <span className={`text-xs ${slots.length > maxPersons ? 'text-amber-500' : 'text-neutral-500'}`}>
          {!models.data
            ? ''
            : maxPersons === 0
            ? `${requiredMode} 방식을 지원하는 활성 모델이 없습니다`
            : slots.length > maxPersons
            ? `${basis}은(는) 최대 ${maxPersons}명까지만 생성할 수 있습니다 — 이대로면 생성이 실패합니다`
            : `${basis} 기준 최대 ${maxPersons}명`}
        </span>
      </div>

      <ol className="space-y-2">
        {slots.map((identityId, i) => {
          const chosen = items.find((x) => x.id === identityId);
          const blocker = chosen ? blockerOf(chosen) : null;
          return (
            <li
              key={i}
              className={`flex flex-wrap items-center gap-3 rounded border px-3 py-2 ${
                chosen && !blocker ? 'border-green-700/60' : 'border-neutral-200 dark:border-neutral-800'
              }`}
            >
              <span className="w-14 shrink-0 text-sm font-medium">위치 {i + 1}</span>
              <select
                aria-label={`위치 ${i + 1} 인물`}
                value={identityId}
                disabled={locked}
                onChange={(e) => choose(i, e.target.value)}
                className={`${selectCls} min-w-0 flex-1 sm:max-w-sm`}
              >
                <option value="">인물 선택</option>
                {items.map((identity) => {
                  const usedAt = slots.findIndex((s, j) => s === identity.id && j !== i);
                  const b = blockerOf(identity);
                  // 이미 이 자리에 있는 인물은 사유가 생겼어도 선택 상태를 보여줘야 한다
                  const unavailable = usedAt !== -1 || (b !== null && identity.id !== identityId);
                  const note = usedAt !== -1 ? ` — 위치 ${usedAt + 1}에 선택됨` : b ? ` — ${b.split(' — ')[0]}` : '';
                  return (
                    <option key={identity.id} value={identity.id} disabled={unavailable}>
                      {identity.code} {identity.displayName}{note}
                    </option>
                  );
                })}
              </select>
              <span className="text-xs">
                {!chosen ? (
                  <span className="text-neutral-500">라이브러리에서 선택하세요</span>
                ) : blocker ? (
                  <span className="text-amber-500">
                    {blocker} · <Link href={`/identities/${chosen.id}`} className="underline">Identity로 이동</Link>
                  </span>
                ) : (
                  <span className="text-green-500">캐스팅 가능 · 프로파일 v{chosen.activeProfile?.version}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      <ErrorBox error={save.error} />
      <div className="flex items-center justify-end gap-3">
        {empty !== -1 ? <span className="text-xs text-amber-500">위치 {empty + 1}의 인물을 선택하세요</span> : null}
        <Button onClick={() => save.mutate()} disabled={locked || !dirty || empty !== -1 || save.isPending}>
          {save.isPending ? '저장 중…' : dirty ? '캐스팅 저장' : '저장됨'}
        </Button>
      </div>
    </div>
  );
}

interface Row { seconds: string; prompt: string }

const toRows = (segments: SetupSegment[]): Row[] =>
  segments.length
    ? segments.map((s) => ({
        seconds: String((s.endMs - s.startMs) / 1000),
        prompt: s.prompt ?? s.scenePrompt ?? '',
      }))
    : [{ seconds: '5', prompt: '' }];

/**
 * 구간 구성 — 구간 하나가 씬 하나·세그먼트 하나가 되어, 구간마다 다른 프롬프트를 쓴다.
 * 씬 재정의는 세그먼트를 새로 만들기 때문에(생성 기록도 함께 지워진다) 생성한 구간이 있으면 막는다.
 */
function SegmentComposer({
  projectId, status, segments,
}: { projectId: string; status: string; segments: SetupSegment[] }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() => toRows(segments));
  const generated = segments.some((s) => s.attemptCount > 0);
  // 구간을 다시 저장하면 세그먼트가 새로 만들어져 붙어 있던 참고 이미지가 사라진다(api도 막는다)
  const attached = segments.reduce((n, s) => n + s.references.length, 0);
  const locked = generated || attached > 0 || status === 'RUNNING';
  // 구간 저장은 세그먼트를 새로 만든다 — 바뀐 게 없을 때 누르면 목록에서 고친 프롬프트만 잃는다
  const dirty = segments.length === 0 || JSON.stringify(rows) !== JSON.stringify(toRows(segments));

  const parsed = rows.map((r) => Number(r.seconds));
  const invalid = parsed.some((s) => !Number.isFinite(s) || s < 1 || s > 60);
  const totalSec = parsed.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

  const save = useMutation({
    mutationFn: () => {
      let cursor = 0;
      const scenes = rows.map((r, sceneIndex) => {
        const startMs = cursor;
        cursor += Math.round(Number(r.seconds) * 1000);
        return { sceneIndex, startMs, endMs: cursor, prompt: r.prompt.trim() || undefined };
      });
      return put(`/projects/${projectId}/scenes`, { scenes });
    },
    onSuccess: () => {
      for (const key of ['project-segments', 'project', 'project-dashboard']) qc.invalidateQueries({ queryKey: [key, projectId] });
    },
  });

  const update = (i: number, patch: Partial<Row>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        영상을 구간으로 나누고 구간마다 장면을 적습니다. 구간 하나가 생성·QC의 단위입니다.
        Higgsfield Veo는 구간당 4·6·8초만 만들 수 있으니 8초 이하를 권장합니다.
      </p>
      {locked ? (
        <p className="text-xs text-amber-500">
          {generated
            ? '이미 생성한 구간이 있어 구성을 바꿀 수 없습니다 — 바꾸면 생성 기록이 삭제됩니다. 프롬프트는 아래 세그먼트 목록에서 고치세요.'
            : attached > 0
            ? `참고 이미지 ${attached}장이 붙어 있어 구성을 바꿀 수 없습니다 — 바꾸면 첨부가 사라집니다. 첨부를 먼저 지우세요.`
            : '생성 진행 중에는 구성을 바꿀 수 없습니다.'}
        </p>
      ) : null}
      <ol className="space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-2 w-6 shrink-0 font-mono text-xs text-neutral-500">{i}</span>
            <label className="shrink-0 text-xs text-neutral-500">
              길이(초)
              <input
                type="number" min={1} max={60} step={0.5}
                value={r.seconds}
                disabled={locked}
                onChange={(e) => update(i, { seconds: e.target.value })}
                className="mt-0.5 block w-20 rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
            </label>
            <label className="min-w-0 flex-1 text-xs text-neutral-500">
              장면 프롬프트
              <textarea
                rows={2}
                value={r.prompt}
                disabled={locked}
                maxLength={4000}
                placeholder="인물의 동작, 카메라 구도, 조명, 분위기"
                onChange={(e) => update(i, { prompt: e.target.value })}
                className="mt-0.5 block w-full resize-y rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
            </label>
            <button
              type="button"
              aria-label={`구간 ${i} 삭제`}
              disabled={locked || rows.length === 1}
              onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
              className="mt-6 text-sm text-neutral-500 hover:text-red-500 disabled:opacity-30"
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      <ErrorBox error={save.error} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="secondary" disabled={locked} onClick={() => setRows((prev) => [...prev, { seconds: '5', prompt: '' }])}>
          구간 추가
        </Button>
        <div className="flex items-center gap-3">
          <span className={`text-xs ${invalid ? 'text-red-500' : 'text-neutral-500'}`}>
            {invalid ? '길이는 1~60초' : `총 ${totalSec}초 · ${rows.length}구간`}
          </span>
          <Button onClick={() => save.mutate()} disabled={locked || invalid || !dirty || save.isPending}>
            {save.isPending ? '저장 중…' : dirty ? '구간 저장' : '저장됨'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * §5.2 DRAFT → READY 조건을 화면에서 채운다: 캐스팅 1명 이상 + 세그먼트 1개 이상
 * (소스 영상을 올린 프로젝트는 트랙 매핑까지 필요하다).
 */
/** 생성 방식·해상도·사용 모델 — 생성 전에만 바꿀 수 있다(api도 DRAFT·READY에서만 허용) */
function SettingsEditor({ projectId, status, config }: { projectId: string; status: string; config: SetupConfig }) {
  const qc = useQueryClient();
  const initial: GenerationSettings = {
    requiredMode: config.requiredMode ?? 'pose-guided',
    resolution: config.resolution ?? '1080p',
    aspectRatio: config.aspectRatio ?? '16:9',
    // 설정이 없는 예전 프로젝트도 소리를 켠 것으로 본다(서버 기본값과 같다)
    audio: config.audio !== false,
    preferredModel: config.preferredModel ?? null,
  };
  const [value, setValue] = useState(initial);
  const locked = !['DRAFT', 'READY'].includes(status);
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);

  const save = useMutation({
    mutationFn: () => patch(`/projects/${projectId}`, { config: value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });

  return (
    <div className="space-y-3">
      <GenerationSettingsFields value={value} onChange={setValue} disabled={locked} />
      <ErrorBox error={save.error} />
      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={locked || !dirty || save.isPending}>
          {save.isPending ? '저장 중…' : dirty ? '설정 저장' : '저장됨'}
        </Button>
      </div>
    </div>
  );
}

export function ProjectSetup({
  projectId, projectType, config, status, cast, segments,
}: {
  projectId: string; projectType: string; config: SetupConfig; status: string; cast: SetupCast[]; segments: SetupSegment[];
}) {
  const requiredMode = config.requiredMode ?? 'pose-guided';
  const models = useModels();
  const castDone = cast.length > 0;
  const segmentsDone = segments.length > 0;
  const ready = castDone && segmentsDone;
  const [open, setOpen] = useState<'settings' | 'cast' | 'segments' | null>(!castDone ? 'cast' : !segmentsDone ? 'segments' : null);
  // 실제 모델을 쓰는지 한눈에 보이게 한다 — 자동 선택이나 pose-guided는 mock으로 생성된다
  const usesRealModel = !!config.preferredModel && !config.preferredModel.startsWith('mock');
  const settingsWarning = !usesRealModel && defaultModelFor(models.data, 'reference') !== null;

  const step = (key: 'settings' | 'cast' | 'segments', done: boolean, title: string, summary: string) => (
    <button
      type="button"
      onClick={() => setOpen(open === key ? null : key)}
      className={`flex w-full items-center justify-between rounded border px-3 py-2 text-left text-sm ${
        open === key ? 'border-neutral-400' : 'border-neutral-200 dark:border-neutral-800'
      }`}
    >
      <span className="flex items-center gap-2">
        <Badge className={done ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}>{done ? '완료' : '필요'}</Badge>
        <span className="font-medium">{title}</span>
        <span className="text-xs text-neutral-500">{summary}</span>
      </span>
      <span className="text-xs text-neutral-500">{open === key ? '접기' : '열기'}</span>
    </button>
  );

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="font-medium">생성 준비</h2>
        <span className={`text-xs ${ready ? 'text-green-500' : 'text-amber-500'}`}>
          {ready ? '생성할 수 있습니다' : '아래 항목을 완료해야 생성할 수 있습니다'}
        </span>
      </div>
      <div className="mt-3 space-y-2">
        {step(
          'settings', !settingsWarning, '0. 생성 설정',
          `${MODE_INFO[requiredMode]?.label ?? requiredMode} · ${config.preferredModel ?? '자동 선택'}${
            settingsWarning ? ' — 지금 설정으로는 개발용 mock으로 생성됩니다' : ''
          }`,
        )}
        {open === 'settings' ? (
          <div className="px-1 pb-2">
            <SettingsEditor
              key={`${requiredMode}|${config.resolution ?? ''}|${config.preferredModel ?? ''}`}
              projectId={projectId}
              status={status}
              config={config}
            />
          </div>
        ) : null}
        {step('cast', castDone, '1. 캐스팅', castDone ? `${cast.length}명` : '출연 인물을 고르세요')}
        {open === 'cast' ? (
          <div className="px-1 pb-2">
            {/* 저장 후 캐스트가 바뀌면 편집 상태를 서버 값으로 다시 맞춘다 */}
            <CastEditor
              key={[...cast].sort((a, b) => a.slotIndex - b.slotIndex).map((c) => c.identityId).join()}
              projectId={projectId}
              projectType={projectType}
              requiredMode={requiredMode}
              preferredModel={config.preferredModel ?? null}
              status={status}
              cast={cast}
            />
          </div>
        ) : null}
        {step('segments', segmentsDone, '2. 구간·프롬프트', segmentsDone ? `${segments.length}구간` : '구간과 장면을 정하세요')}
        {open === 'segments' ? (
          <div className="px-1 pb-2">
            {/* 세그먼트가 바뀌면(구간 저장, 목록에서 프롬프트 수정) 편집 내용을 서버 값으로 다시 맞춘다 */}
            <SegmentComposer
              key={segments.map((s) => `${s.startMs}-${s.endMs}-${s.prompt ?? s.scenePrompt ?? ''}`).join('|')}
              projectId={projectId}
              status={status}
              segments={segments}
            />

          </div>
        ) : null}
      </div>
    </Card>
  );
}
