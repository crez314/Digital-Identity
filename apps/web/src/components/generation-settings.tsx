'use client';

import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';

export interface GenerationSettings {
  requiredMode: string;
  resolution: string;
  /** null이면 점수 기준 자동 선택 */
  preferredModel: string | null;
}

export interface ModelRow {
  code: string;
  status: string;
  costPerSecond: string | number | null;
  capabilities: { modes: string[]; maxPersons: number; maxDurationMs: number; maxResolution: number; durations?: number[] };
}

export const MODE_INFO: Record<string, { label: string; hint: string }> = {
  reference: {
    label: '인물 레퍼런스 영상',
    hint: '등록한 인물 사진 1~3장으로 신원을 유지하며 영상을 만듭니다. Higgsfield를 쓰려면 이 방식을 고르세요.',
  },
  i2v: {
    label: '시작 이미지 영상 (i2v)',
    hint: '인물 사진 1장을 첫 장면으로 움직입니다. 1명만 가능하고 참고 이미지(배경·의상)는 전달되지 않습니다.',
  },
  'pose-guided': {
    label: '소스 영상 동작 따라하기',
    hint: '소스 영상의 동작을 따라 합니다. 지원하는 실제 모델이 없어 개발용 mock으로만 생성됩니다.',
  },
};
const MODES = ['reference', 'i2v', 'pose-guided'];
const isMock = (code: string) => code.startsWith('mock');

export function useModels() {
  return useQuery({ queryKey: ['models'], queryFn: () => get<ModelRow[]>('/models') });
}

export function capableModels(models: ModelRow[] | undefined, mode: string) {
  return (models ?? []).filter((m) => m.status === 'ACTIVE' && m.capabilities.modes.includes(mode));
}

/** 방식을 고르면 실제 모델(Veo 우선)을 기본으로 잡는다 — 자동 선택은 값이 싼 mock을 고르기 쉽다 */
export function defaultModelFor(models: ModelRow[] | undefined, mode: string): string | null {
  const real = capableModels(models, mode).filter((m) => !isMock(m.code));
  return (real.find((m) => m.code.includes('veo')) ?? real[0])?.code ?? null;
}

const selectCls =
  'mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100';

/**
 * 생성 방식·해상도·사용 모델 선택. 프로젝트 생성과 생성 전 설정 변경에서 같이 쓴다.
 * 모델 목록은 활성 모델 중 고른 방식을 지원하는 것만 보여준다.
 */
export function GenerationSettingsFields({
  value, onChange, disabled = false,
}: { value: GenerationSettings; onChange: (v: GenerationSettings) => void; disabled?: boolean }) {
  const models = useModels();
  const capable = capableModels(models.data, value.requiredMode);
  const chosen = capable.find((m) => m.code === value.preferredModel) ?? null;
  const height = Number(value.resolution.replace('p', ''));
  const seconds = chosen?.capabilities.durations?.join('·');

  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-neutral-500">
          생성 방식
          <select
            aria-label="생성 방식"
            value={value.requiredMode}
            disabled={disabled}
            onChange={(e) => {
              const mode = e.target.value;
              onChange({ ...value, requiredMode: mode, preferredModel: defaultModelFor(models.data, mode) });
            }}
            className={selectCls}
          >
            {MODES.map((mode) => (
              <option key={mode} value={mode}>
                {MODE_INFO[mode].label} — 활성 모델 {capableModels(models.data, mode).length}개
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-neutral-500">
          해상도
          <select aria-label="해상도" value={value.resolution} disabled={disabled} onChange={(e) => onChange({ ...value, resolution: e.target.value })} className={selectCls}>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
          </select>
        </label>
        <label className="text-xs text-neutral-500">
          사용 모델
          <select
            aria-label="사용 모델"
            value={value.preferredModel ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, preferredModel: e.target.value || null })}
            className={selectCls}
          >
            <option value="">자동 선택 (점수 기준)</option>
            {capable.map((m) => (
              <option key={m.code} value={m.code}>
                {m.code} · 최대 {m.capabilities.maxPersons}명{isMock(m.code) ? ' · 개발용' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ul className="space-y-0.5 text-xs text-neutral-500">
        <li>{MODE_INFO[value.requiredMode]?.hint}</li>
        {!value.preferredModel ? (
          <li className={capable.some((m) => isMock(m.code)) ? 'text-amber-500' : ''}>
            자동 선택은 비용이 낮은 모델에 점수를 더 줘서{capable.some((m) => isMock(m.code)) ? ' 켜져 있는 개발용 mock이 선택될 수 있습니다' : ' 활성 모델 중 하나를 고릅니다'}.
          </li>
        ) : chosen && !isMock(chosen.code) ? (
          <li className="text-amber-500">
            Higgsfield 실제 API로 생성되며 생성할 때마다 과금됩니다 (QC 실패 시 구간당 최대 3회) · 최대 {chosen.capabilities.maxPersons}명
            {seconds ? ` · 구간 길이 ${seconds}초로 맞춰짐` : ''}
          </li>
        ) : chosen ? (
          <li>개발용 mock — 실제 영상 대신 테스트 패턴이 만들어집니다.</li>
        ) : (
          <li className="text-red-500">{value.preferredModel}은(는) 이 방식을 지원하지 않거나 꺼져 있습니다.</li>
        )}
        {chosen && chosen.capabilities.maxResolution < height ? (
          <li className="text-red-500">이 모델은 최대 {chosen.capabilities.maxResolution}p까지만 생성합니다.</li>
        ) : null}
      </ul>
    </div>
  );
}
