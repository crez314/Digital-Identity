'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, post, put } from '@/lib/api';
import { Badge, Button, Card, ErrorBox, Loading } from '@/components/ui';

interface RulesetRow {
  version: string;
  weights: Record<string, number>;
  thresholds: Record<string, number>;
  isActive: boolean;
  note: string | null;
  createdAt: string;
}

const WEIGHT_LABELS: Record<string, string> = {
  face: '얼굴 유사도', body: '신체 유사도', temporal: '시간 일관성',
  binding: '바인딩 안정성', motion: '모션 정합도',
};

const THRESHOLD_LABELS: Record<string, string> = {
  perIdentityMin: '인물별 하한', maxSpread: '캐스트 간 편차 허용', overallMin: '종합 하한',
  driftDropRatio: 'DRIFT 하락률', driftMinDurationSec: 'DRIFT 최소 지속(초)',
  blendMargin: 'BLEND margin', blendMinDurationSec: 'BLEND 최소 지속(초)',
  swapMinDurationSec: 'SWAP 최소 지속(초)', flickerZScore: 'FLICKER z-score',
  trackLostMinDurationSec: 'TRACK_LOST 최소 지속(초)', minFrameQuality: '유효 프레임 최소 품질',
};

/**
 * §19 Phase 2 — ruleset 버전 관리 및 임계값 튜닝 화면.
 * 가중치·임계값은 코드가 아니라 DB에 있으므로 배포 없이 조정할 수 있다(§10).
 */
export default function RulesetsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['rulesets'], queryFn: () => get<RulesetRow[]>('/qc/rulesets') });

  const [version, setVersion] = useState('');
  const [note, setNote] = useState('');
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [thresholds, setThresholds] = useState<Record<string, number>>({});

  const active = list.data?.find((r) => r.isActive);
  useEffect(() => {
    if (active && Object.keys(weights).length === 0) {
      setWeights(active.weights);
      setThresholds(active.thresholds);
    }
  }, [active, weights]);

  const create = useMutation({
    mutationFn: () => post('/qc/rulesets', { version, weights, thresholds, note }),
    onSuccess: () => {
      setVersion('');
      setNote('');
      qc.invalidateQueries({ queryKey: ['rulesets'] });
    },
  });

  const activate = useMutation({
    mutationFn: (v: string) => put(`/qc/rulesets/${v}/activate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rulesets'] }),
  });

  const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);

  if (list.isLoading) return <Loading />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">QC Ruleset</h1>
        <p className="mt-1 text-sm text-neutral-500">
          점수 가중치와 임계값. 적용된 버전은 qc_run에 기록되어 과거 판정을 재현할 수 있다.
        </p>
      </div>

      <Card>
        <div className="flex items-center justify-between">
          <h2 className="font-medium">버전</h2>
        </div>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr><th className="py-1">버전</th><th>가중치</th><th>비고</th><th>생성</th><th /></tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((r) => (
              <tr key={r.version} className="border-t border-neutral-100 dark:border-neutral-800">
                <td className="py-2 font-mono">
                  {r.version} {r.isActive ? <Badge className="ml-2 bg-green-100 text-green-800">ACTIVE</Badge> : null}
                </td>
                <td className="font-mono text-xs text-neutral-500">
                  {Object.entries(r.weights).map(([k, v]) => `${k[0].toUpperCase()}${v}`).join(' ')}
                </td>
                <td className="max-w-xs truncate text-xs text-neutral-500">{r.note ?? '—'}</td>
                <td className="text-xs text-neutral-400">{r.createdAt.slice(0, 10)}</td>
                <td className="text-right">
                  {!r.isActive ? (
                    <Button variant="secondary" onClick={() => activate.mutate(r.version)}>활성화</Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ErrorBox error={activate.error} />
      </Card>

      <Card>
        <h2 className="font-medium">새 버전 등록</h2>
        <p className="mt-1 text-xs text-neutral-500">
          등록만 하고 활성화는 별도 조작이다 — 실수로 즉시 반영되지 않게 분리했다.
        </p>

        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center justify-between text-sm font-medium">
              <span>가중치</span>
              <span className={Math.abs(weightSum - 1) < 0.001 ? 'text-green-600' : 'text-amber-600'}>
                합계 {weightSum.toFixed(2)}
              </span>
            </div>
            <div className="space-y-2">
              {Object.entries(WEIGHT_LABELS).map(([key, label]) => (
                <label key={key} className="flex items-center gap-3 text-sm">
                  <span className="w-28 text-neutral-600 dark:text-neutral-400">{label}</span>
                  <input
                    type="range" min={0} max={1} step={0.01}
                    value={weights[key] ?? 0}
                    onChange={(e) => setWeights({ ...weights, [key]: Number(e.target.value) })}
                    className="flex-1"
                  />
                  <span className="w-12 text-right font-mono text-xs">{(weights[key] ?? 0).toFixed(2)}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium">임계값</div>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(THRESHOLD_LABELS).map(([key, label]) => (
                <label key={key} className="text-xs">
                  <span className="block text-neutral-500">{label}</span>
                  <input
                    type="number" step={0.01}
                    value={thresholds[key] ?? 0}
                    onChange={(e) => setThresholds({ ...thresholds, [key]: Number(e.target.value) })}
                    className="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 font-mono dark:border-neutral-700 dark:bg-neutral-900"
                  />
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="버전 (예: qc-v2)"
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="변경 사유"
            className="flex-1 rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <Button onClick={() => create.mutate()} disabled={!version || create.isPending}>등록</Button>
        </div>
        <ErrorBox error={create.error} />
      </Card>
    </div>
  );
}
