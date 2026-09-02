'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui';
import { FINDING_LABELS, SEVERITY_COLORS, ms as fmtMs } from '@/lib/format';

export interface Finding {
  id: string;
  identityId: string | null;
  findingType: string;
  severity: string;
  startMs: number;
  endMs: number;
  confidence: number;
  evidence: {
    frameIndices?: number[];
    similaritySeries?: number[];
    thumbnailKeys?: string[];
    baseline?: number;
    note?: string;
  };
}

/**
 * §19 Phase 2 — QC 결과 뷰어.
 * 타임라인에 오류 구간을 표시하고 근거 프레임을 확인할 수 있어야 한다.
 * 사람이 전 구간을 보지 않고 QC 결과만으로 문제 구간을 찾을 수 있게 하는 것이 목표다.
 */
export function QcTimeline({
  durationMs,
  findings,
  identityNames,
  onSeek,
}: {
  durationMs: number;
  findings: Finding[];
  identityNames: Record<string, string>;
  onSeek?: (ms: number) => void;
}) {
  const [selected, setSelected] = useState<Finding | null>(null);
  const total = Math.max(durationMs, 1);

  // 인물별 레인으로 나눈다. identityId가 없는 아티팩트는 공용 레인.
  const lanes = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = f.identityId ?? '__artifact__';
    lanes.set(key, [...(lanes.get(key) ?? []), f]);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {[...lanes.entries()].map(([key, list]) => (
          <div key={key}>
            <div className="mb-1 text-xs text-neutral-500">
              {key === '__artifact__' ? '아티팩트 (인물 무관)' : identityNames[key] ?? key.slice(0, 8)}
            </div>
            <div className="relative h-8 w-full rounded bg-neutral-100 dark:bg-neutral-800">
              {list.map((f) => {
                const left = (f.startMs / total) * 100;
                const width = Math.max(((f.endMs - f.startMs) / total) * 100, 0.6);
                return (
                  <button
                    key={f.id}
                    title={`${FINDING_LABELS[f.findingType] ?? f.findingType} ${fmtMs(f.startMs)}–${fmtMs(f.endMs)}`}
                    onClick={() => {
                      setSelected(f);
                      onSeek?.(f.startMs);
                    }}
                    className={`absolute top-1 h-6 rounded ${SEVERITY_COLORS[f.severity] ?? 'bg-neutral-400'} ${
                      selected?.id === f.id ? 'ring-2 ring-neutral-900 dark:ring-neutral-100' : ''
                    }`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div className="flex justify-between text-[11px] text-neutral-400">
          <span>00:00.00</span>
          <span>{fmtMs(total)}</span>
        </div>
      </div>

      {selected ? (
        <div className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <Badge className={SEVERITY_COLORS[selected.severity] ?? ''}>{selected.severity}</Badge>
            <span className="font-medium">{FINDING_LABELS[selected.findingType] ?? selected.findingType}</span>
            <span className="font-mono text-xs text-neutral-500">
              {fmtMs(selected.startMs)} – {fmtMs(selected.endMs)}
            </span>
            <span className="ml-auto text-xs text-neutral-500">신뢰도 {selected.confidence.toFixed(3)}</span>
          </div>

          {selected.evidence.note ? (
            <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">{selected.evidence.note}</p>
          ) : null}

          {selected.evidence.similaritySeries?.length ? (
            <Sparkline
              values={selected.evidence.similaritySeries}
              baseline={selected.evidence.baseline}
            />
          ) : null}

          {selected.evidence.thumbnailKeys?.length ? (
            <div className="mt-3">
              <div className="text-xs text-neutral-500">근거 프레임</div>
              <div className="mt-1 font-mono text-[11px] text-neutral-400">
                {selected.evidence.thumbnailKeys.join(', ')}
              </div>
            </div>
          ) : (
            <div className="mt-3 text-xs text-neutral-400">근거 프레임 썸네일 없음</div>
          )}
        </div>
      ) : (
        <div className="text-xs text-neutral-400">타임라인의 구간을 클릭하면 근거를 확인할 수 있습니다.</div>
      )}
    </div>
  );
}

/** 유사도 시계열 스파크라인 — baseline 대비 하락을 눈으로 확인할 수 있게 한다 */
function Sparkline({ values, baseline }: { values: number[]; baseline?: number }) {
  if (values.length < 2) return null;
  const w = 320;
  const h = 60;
  const min = Math.min(...values, baseline ?? 1);
  const max = Math.max(...values, baseline ?? 0);
  const range = max - min || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(' ');
  const baseY = baseline !== undefined ? h - ((baseline - min) / range) * h : null;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-3 h-16 w-full max-w-md" role="img" aria-label="유사도 시계열">
      {baseY !== null ? (
        <line x1="0" y1={baseY} x2={w} y2={baseY} stroke="currentColor" strokeDasharray="4 3" className="text-neutral-400" />
      ) : null}
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" className="text-red-500" />
    </svg>
  );
}
