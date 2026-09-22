'use client';

import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';

export interface GenerationSettings {
  requiredMode: string;
  resolution: string;
  /** 출력 화면 비율. 비워 두면 서버가 16:9로 둔다 */
  aspectRatio: string;
  /** null이면 점수 기준 자동 선택 */
  preferredModel: string | null;
}

/** 화면 비율을 지정할 수 있는 제공자 — kling은 시작 이미지 비율을 따른다(§12.1) */
const ASPECT_CAPABLE = (code: string | null) => !!code && !code.includes('kling');

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
  v2v: {
    label: '영상 변환 (v2v)',
    hint: '소스 영상을 바꿔 새 영상을 만듭니다. 현재 지원 모델은 개발용 mock뿐입니다.',
  },
  'pose-guided': {
    label: '소스 영상 동작 따라하기',
    hint: '소스 영상의 동작을 따라 합니다. 지원하는 실제 모델이 없어 개발용 mock으로만 생성됩니다.',
  },
};
const MODES = ['reference', 'i2v', 'v2v', 'pose-guided'];
const isMock = (code: string) => code.startsWith('mock');

export function useModels() {
  return useQuery({ queryKey: ['models'], queryFn: () => get<ModelRow[]>('/models') });
}

export function capableModels(models: ModelRow[] | undefined, mode: string) {
  return (models ?? []).filter((m) => m.status === 'ACTIVE' && m.capabilities.modes.includes(mode));
}

/**
 * 방식을 고르면 실제 모델을 기본으로 잡는다 — 자동 선택에 맡기면 값이 싼 mock이 뽑히기 쉽다.
 * 신원 조건화가 되는 Veo가 있으면 그것을, 없으면 단가가 가장 낮은 모델을 고른다.
 * 목록 순서(알파벳)대로 잡으면 가장 비싼 모델이 기본값이 되는 일이 생긴다.
 */
export function defaultModelFor(models: ModelRow[] | undefined, mode: string): string | null {
  const real = capableModels(models, mode).filter((m) => !isMock(m.code));
  const cheapest = [...real].sort((a, b) => Number(a.costPerSecond ?? 0) - Number(b.costPerSecond ?? 0))[0];
  return (real.find((m) => m.code.includes('veo')) ?? cheapest)?.code ?? null;
}

/**
 * 쓸 수 있는 모델이 있는 첫 방식을 기본값으로 잡는다.
 * 'reference'를 고정 기본값으로 두면, veo3.1이 계정에서 막힌 지금처럼 모델 목록이 빈 채로 보인다.
 */
export function defaultMode(models: ModelRow[] | undefined): string {
  return MODES.find((mode) => capableModels(models, mode).length > 0) ?? 'i2v';
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
  const all = models.data ?? [];
  const capable = capableModels(models.data, value.requiredMode);
  // 고른 방식을 지원하지 않는 활성 모델도 목록에 보여준다 — 고르면 방식을 그 모델에 맞춰 바꾼다
  const otherMode = all.filter((m) => m.status === 'ACTIVE' && !m.capabilities.modes.includes(value.requiredMode));
  // 비활성 모델은 왜 못 고르는지 알 수 있도록 보여주되 선택은 막는다
  const inactive = all.filter((m) => m.status !== 'ACTIVE');
  const chosen = all.find((m) => m.code === value.preferredModel) ?? null;
  const chosenUnusable = chosen && chosen.status !== 'ACTIVE';
  const chosenWrongMode = chosen && !chosen.capabilities.modes.includes(value.requiredMode);
  const modeLabels = (m: ModelRow) => m.capabilities.modes.map((x) => MODE_INFO[x]?.label ?? x).join(' / ');
  const height = Number(value.resolution.replace('p', ''));
  // 3~15초·4~30초처럼 범위로 받는 모델은 전부 나열하면 읽을 수 없다 — 연속이면 범위로 적는다
  const durations = chosen?.capabilities.durations ?? [];
  const contiguous = durations.length > 3 && durations.every((d, i) => i === 0 || d === durations[i - 1] + 1);
  const seconds = contiguous ? `${durations[0]}~${durations[durations.length - 1]}` : durations.join('·');

  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-4">
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
          화면 비율
          <select aria-label="화면 비율" value={value.aspectRatio} disabled={disabled} onChange={(e) => onChange({ ...value, aspectRatio: e.target.value })} className={selectCls}>
            <option value="16:9">16:9 (가로)</option>
            <option value="9:16">9:16 (세로)</option>
          </select>
        </label>
        <label className="text-xs text-neutral-500">
          사용 모델
          <select
            aria-label="사용 모델"
            value={value.preferredModel ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const code = e.target.value;
              if (!code) return onChange({ ...value, preferredModel: null });
              // 다른 방식 전용 모델을 고르면 방식도 함께 바꾼다 — 그러지 않으면 저장할 때 서버가 거절한다
              const picked = all.find((m) => m.code === code);
              const mode = picked && !picked.capabilities.modes.includes(value.requiredMode)
                ? picked.capabilities.modes[0]
                : value.requiredMode;
              onChange({ ...value, requiredMode: mode, preferredModel: code });
            }}
            className={selectCls}
          >
            <option value="">자동 선택 (점수 기준)</option>
            {capable.length ? (
              <optgroup label="이 방식 지원">
                {capable.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.code} · 최대 {m.capabilities.maxPersons}명{isMock(m.code) ? ' · 개발용' : ''}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {otherMode.length ? (
              <optgroup label="다른 방식 전용 — 고르면 방식이 바뀝니다">
                {otherMode.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.code} · {modeLabels(m)}{isMock(m.code) ? ' · 개발용' : ''}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {inactive.length ? (
              <optgroup label="비활성 — 계정에서 호출할 수 없음">
                {inactive.map((m) => (
                  <option key={m.code} value={m.code} disabled>
                    {m.code} · {modeLabels(m)} · {m.status}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
      </div>

      <ul className="space-y-0.5 text-xs text-neutral-500">
        <li>{MODE_INFO[value.requiredMode]?.hint}</li>
        {capable.length === 0 ? (
          <li className="text-red-500">
            이 방식을 지원하는 활성 모델이 없습니다 — 사용 모델 목록에서 다른 방식의 모델을 고르면 방식이 함께 바뀝니다.
          </li>
        ) : null}
        {chosenUnusable ? (
          <li className="text-red-500">{chosen?.code}은(는) {chosen?.status} 상태라 생성이 실패합니다.</li>
        ) : chosenWrongMode ? (
          <li className="text-red-500">
            {chosen?.code}은(는) {modeLabels(chosen!)} 방식 전용입니다 — 지금 방식으로는 저장되지 않습니다.
          </li>
        ) : null}
        {!value.preferredModel ? (
          <li className={capable.some((m) => isMock(m.code)) ? 'text-amber-500' : ''}>
            자동 선택은 비용이 낮은 모델에 점수를 더 줘서{capable.some((m) => isMock(m.code)) ? ' 켜져 있는 개발용 mock이 선택될 수 있습니다' : ' 활성 모델 중 하나를 고릅니다'}.
          </li>
        ) : chosen && !chosenUnusable && !chosenWrongMode && !isMock(chosen.code) ? (
          <li className="text-amber-500">
            Higgsfield 실제 API로 생성되며 생성할 때마다 과금됩니다 · 최대 {chosen.capabilities.maxPersons}명
            {seconds ? ` · 구간 길이 ${seconds}초로 맞춰짐` : ''} · QC 실패해도 자동 재생성하지 않습니다(운영자가 수동으로 재생성)
          </li>
        ) : chosen ? (
          <li>개발용 mock — 실제 영상 대신 테스트 패턴이 만들어집니다.</li>
        ) : (
          <li className="text-red-500">{value.preferredModel}은(는) 이 방식을 지원하지 않거나 꺼져 있습니다.</li>
        )}
        {chosen && !ASPECT_CAPABLE(chosen.code) ? (
          <li className="text-amber-500">
            이 모델은 화면 비율을 지정할 수 없어 시작 이미지 비율을 그대로 따릅니다 — {value.aspectRatio}로 만들려면 그 비율의 사진을 쓰세요.
          </li>
        ) : null}
        {chosen && chosen.capabilities.maxResolution < height ? (
          <li className="text-red-500">이 모델은 최대 {chosen.capabilities.maxResolution}p까지만 생성합니다.</li>
        ) : null}
      </ul>
    </div>
  );
}
