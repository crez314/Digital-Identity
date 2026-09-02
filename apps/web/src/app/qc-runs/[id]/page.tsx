'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { use, useRef, useState } from 'react';
import { get, post } from '@/lib/api';
import { Badge, Button, Card, ErrorBox, Loading } from '@/components/ui';
import { QcTimeline, type Finding } from '@/components/qc-timeline';
import { pct, score } from '@/lib/format';

interface QcRunDetail {
  id: string;
  segmentId: string;
  attempt: number;
  modelCode: string;
  rulesetVersion: string;
  status: string;
  overallScore: number | null;
  perIdentity: Record<string, Record<string, number>> | null;
  outputUrl: string;
  seriesUrl: string | null;
  findings: Finding[];
  createdAt: string;
}

const METRIC_LABELS: Record<string, string> = {
  faceSimilarity: '얼굴 유사도',
  bodySimilarity: '신체 유사도',
  temporalConsistency: '시간 일관성',
  motionConsistency: '모션 정합도',
  bindingStability: '바인딩 안정성',
  validFrameRatio: '유효 프레임',
  score: '종합',
};

export default function QcRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const video = useRef<HTMLVideoElement>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['qc-run', id],
    queryFn: () => get<QcRunDetail>(`/qc-runs/${id}`),
  });

  const accept = useMutation({
    mutationFn: () => post(`/segments/${data?.segmentId}/accept`, { reason }),
    onSuccess: () => refetch(),
  });

  const regenerate = useMutation({
    mutationFn: () => post(`/segments/${data?.segmentId}/regenerate`, { reason }),
    onSuccess: () => refetch(),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const durationMs = Math.max(...data.findings.map((f) => f.endMs), 1000);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">QC 결과</h1>
          <div className="mt-1 flex items-center gap-3 text-xs text-neutral-500">
            <span>attempt {data.attempt}</span>
            <span>모델 {data.modelCode}</span>
            <span className="font-mono">ruleset {data.rulesetVersion}</span>
          </div>
        </div>
        <div className="text-right">
          <Badge className={data.status === 'PASSED' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'}>
            {data.status}
          </Badge>
          <div className="mt-1 text-2xl font-semibold">{score(data.overallScore)}</div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-medium">결과물</h2>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={video} src={data.outputUrl} controls className="w-full rounded bg-black" />
        </Card>

        <Card>
          <h2 className="mb-3 font-medium">인물별 지표 (§10.1)</h2>
          {data.perIdentity ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-neutral-500">
                <tr>
                  <th className="py-1">인물</th>
                  {Object.keys(METRIC_LABELS).map((k) => (
                    <th key={k} className="px-1">{METRIC_LABELS[k]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.perIdentity).map(([identityId, metrics]) => (
                  <tr key={identityId} className="border-t border-neutral-100 dark:border-neutral-800">
                    <td className="py-2 font-mono text-xs">{identityId.slice(0, 8)}</td>
                    {Object.keys(METRIC_LABELS).map((k) => (
                      <td key={k} className="px-1 tabular-nums">
                        {metrics[k] === null || metrics[k] === undefined ? '—' : Number(metrics[k]).toFixed(3)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-sm text-neutral-400">지표 없음</div>
          )}
        </Card>
      </div>

      <Card>
        <h2 className="mb-3 font-medium">오류 구간 ({data.findings.length}) — §10.2</h2>
        <QcTimeline
          durationMs={durationMs}
          findings={data.findings}
          identityNames={{}}
          onSeek={(ms) => {
            if (video.current) video.current.currentTime = ms / 1000;
          }}
        />
      </Card>

      {data.status !== 'PASSED' ? (
        <Card>
          <h2 className="font-medium">운영자 처리</h2>
          <p className="mt-1 text-xs text-neutral-500">
            QC 실패 세그먼트의 수동 승인은 사유가 필수이며 별도 감사 대상 행위다 (§14.2).
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="사유 (10자 이상)"
            rows={2}
            className="mt-3 w-full rounded border border-neutral-300 p-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <ErrorBox error={accept.error ?? regenerate.error} />
          <div className="mt-3 flex gap-2">
            <Button onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
              재생성 요청
            </Button>
            <Button variant="secondary" onClick={() => accept.mutate()} disabled={reason.length < 10 || accept.isPending}>
              그대로 승인
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
