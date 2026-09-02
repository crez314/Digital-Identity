'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { use } from 'react';
import { get, post } from '@/lib/api';
import { Badge, Button, Card, ErrorBox, Loading } from '@/components/ui';
import { pct, score } from '@/lib/format';

interface Coverage {
  requiredFaceSlots: string[];
  requiredBodySlots: string[];
  filledSlots: string[];
  missingSlots: string[];
  coverageRatio: number;
  buildable: boolean;
}

interface AssetRow {
  id: string;
  assetType: string;
  captureSlot: string | null;
  expression: string | null;
  qualityScore: number | null;
  isUsable: boolean;
  createdAt: string;
}

interface ProfileRow {
  id: string;
  version: number;
  status: string;
  faceVariance: number | null;
  attributes: Record<string, unknown>;
  modelBundle: Record<string, unknown>;
  builtAt: string | null;
}

export default function IdentityDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();

  const identity = useQuery({ queryKey: ['identity', id], queryFn: () => get<{ displayName: string; code: string; status: string }>(`/identities/${id}`) });
  const assets = useQuery({
    queryKey: ['identity-assets', id],
    queryFn: () => get<{ assets: AssetRow[]; coverage: Coverage }>(`/identities/${id}/assets`),
  });
  const profiles = useQuery({ queryKey: ['identity-profiles', id], queryFn: () => get<ProfileRow[]>(`/identities/${id}/profiles`) });

  const build = useMutation({
    mutationFn: () => post(`/identities/${id}/profile/build`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['identity-profiles', id] });
    },
  });

  const activate = useMutation({
    mutationFn: (version: number) => post(`/identities/${id}/profiles/${version}/activate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['identity-profiles', id] });
      qc.invalidateQueries({ queryKey: ['identity', id] });
    },
  });

  if (identity.isLoading) return <Loading />;
  const cov = assets.data?.coverage;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-xs text-neutral-500">{identity.data?.code}</div>
          <h1 className="text-xl font-semibold">{identity.data?.displayName}</h1>
        </div>
        <Button onClick={() => build.mutate()} disabled={!cov?.buildable || build.isPending}>
          프로파일 빌드
        </Button>
      </div>

      <ErrorBox error={build.error ?? activate.error} />

      {/* §6.1 캡처 슬롯 충족률 — 미충족이면 CREZ-IDN-001로 빌드가 거절된다 */}
      {cov ? (
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-medium">캡처 슬롯 충족률</h2>
            <span className="text-sm text-neutral-500">
              {pct(cov.coverageRatio)} {cov.buildable ? '· 빌드 가능' : '· 빌드 불가'}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {[...cov.requiredFaceSlots, ...cov.requiredBodySlots].map((slot) => {
              const filled = cov.filledSlots.includes(slot);
              return (
                <Badge
                  key={slot}
                  className={filled ? 'bg-green-100 text-green-800' : 'bg-neutral-200 text-neutral-500 line-through'}
                >
                  {slot}
                </Badge>
              );
            })}
          </div>
          {!cov.buildable ? (
            <div className="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <span className="font-mono">CREZ-IDN-001</span> 미충족 슬롯: {cov.missingSlots.join(', ')}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <h2 className="font-medium">프로파일 버전</h2>
        <p className="mt-1 text-xs text-neutral-500">
          프로젝트는 특정 버전을 고정(pin)해 참조하므로, 갱신해도 과거 프로젝트의 재생성 결과는 달라지지 않는다.
        </p>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr>
              <th className="py-1">버전</th><th>상태</th><th>임베딩 산포</th><th>모델</th><th>빌드 시각</th><th />
            </tr>
          </thead>
          <tbody>
            {(profiles.data ?? []).map((p) => (
              <tr key={p.id} className="border-t border-neutral-100 dark:border-neutral-800">
                <td className="py-2 font-mono">v{p.version}</td>
                <td>
                  <Badge className={p.status === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-neutral-200 text-neutral-600'}>
                    {p.status}
                  </Badge>
                </td>
                <td>{score(p.faceVariance)}</td>
                <td className="font-mono text-xs text-neutral-500">
                  {String((p.modelBundle as { faceEmbedder?: string })?.faceEmbedder ?? '—')}
                </td>
                <td className="text-xs text-neutral-500">{p.builtAt?.slice(0, 19).replace('T', ' ') ?? '—'}</td>
                <td className="text-right">
                  {p.status !== 'ACTIVE' && p.status !== 'BUILDING' ? (
                    <Button variant="secondary" onClick={() => activate.mutate(p.version)}>활성화</Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <h2 className="font-medium">자산 ({assets.data?.assets.length ?? 0})</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr><th className="py-1">유형</th><th>슬롯</th><th>표정</th><th>품질</th><th>사용</th></tr>
          </thead>
          <tbody>
            {(assets.data?.assets ?? []).map((a) => (
              <tr key={a.id} className="border-t border-neutral-100 dark:border-neutral-800">
                <td className="py-2">{a.assetType}</td>
                <td className="font-mono text-xs">{a.captureSlot ?? '—'}</td>
                <td className="text-xs">{a.expression ?? '—'}</td>
                <td>{score(a.qualityScore)}</td>
                <td>
                  <Badge className={a.isUsable ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'}>
                    {a.isUsable ? '사용' : '제외'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
