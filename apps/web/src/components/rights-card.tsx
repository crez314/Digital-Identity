'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '@/lib/api';
import { Badge, Button, Card, ErrorBox } from '@/components/ui';

interface RightsRow {
  ownerName: string;
  contractRef: string | null;
  consentStatus: string;
  allowedUsage: string[];
  restrictedUsage: string[];
  territories: string[];
  commercialUse: boolean;
  trainingPermitted: boolean;
  syntheticPermitted: boolean;
  startsAt: string;
  expiresAt: string | null;
  createdAt: string;
}

const USAGE = ['MV', 'SHORTS', 'TEASER', 'THUMBNAIL', 'CONCERT', 'AD'];
const CONSENT_LABEL: Record<string, string> = {
  GRANTED: '동의함', PENDING: '동의 대기', REVOKED: '철회', EXPIRED: '만료',
};
const today = () => new Date().toISOString().slice(0, 10);
const inputCls =
  'mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100';

/**
 * §6.2 권리 정보. 캐스팅·생성·배포 게이트(§14.1)가 가장 최근 기록으로 판정한다.
 * 기록은 수정되지 않고 새 기록이 쌓인다(§14.2) — 동의 여부처럼 법적 의미가 있는 값은 기본값을 두지 않는다.
 */
export function RightsCard({ identityId }: { identityId: string }) {
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ['identity-rights', identityId],
    queryFn: () => get<RightsRow | null>(`/identities/${identityId}/rights`),
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    ownerName: '', contractRef: '', consentStatus: '', synthetic: '' as '' | 'yes' | 'no',
    commercialUse: false, allowedUsage: ['MV'] as string[], restrictedUsage: [] as string[],
    territories: 'KR', startsAt: today(), expiresAt: '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const territories = form.territories.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  const problems = [
    !form.ownerName.trim() && '권리자',
    !form.consentStatus && '동의 상태',
    !form.synthetic && '합성 콘텐츠 생성 허용 여부',
    territories.some((t) => !/^[A-Z]{2}$/.test(t)) && '지역 코드(KR, JP 같은 두 글자)',
    form.expiresAt && form.expiresAt < form.startsAt && '종료일(시작일 이후)',
  ].filter(Boolean) as string[];

  const save = useMutation({
    mutationFn: () =>
      put(`/identities/${identityId}/rights`, {
        ownerName: form.ownerName.trim(),
        contractRef: form.contractRef.trim() || undefined,
        consentStatus: form.consentStatus,
        allowedUsage: form.allowedUsage,
        restrictedUsage: form.restrictedUsage,
        territories,
        commercialUse: form.commercialUse,
        trainingPermitted: false,
        syntheticPermitted: form.synthetic === 'yes',
        startsAt: `${form.startsAt}T00:00:00.000Z`,
        expiresAt: form.expiresAt ? `${form.expiresAt}T23:59:59.000Z` : null,
      }),
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['identity-rights', identityId] });
    },
  });

  const toggle = (key: 'allowedUsage' | 'restrictedUsage', usage: string, on: boolean) =>
    set({ [key]: on ? [...form[key], usage] : form[key].filter((u) => u !== usage) } as Partial<typeof form>);

  const r = current.data;
  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="font-medium">권리 정보</h2>
        <Button variant="secondary" onClick={() => setOpen(!open)}>{open ? '닫기' : r ? '새 기록 등록' : '권리 정보 등록'}</Button>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        캐스팅·생성·배포 때 가장 최근 기록으로 권리를 검사합니다. 기록은 고쳐지지 않고 새로 쌓이며,
        철회로 등록하면 진행 중인 생성이 취소되고 완성본 배포가 차단됩니다.
      </p>

      {r ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-neutral-500">동의</dt><dd>
            <Badge className={r.consentStatus === 'GRANTED' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'}>
              {CONSENT_LABEL[r.consentStatus] ?? r.consentStatus}
            </Badge>
          </dd></div>
          <div><dt className="text-xs text-neutral-500">권리자</dt><dd>{r.ownerName}</dd></div>
          <div><dt className="text-xs text-neutral-500">허용 용도</dt><dd>{r.allowedUsage.join(', ') || '제한 없음'}</dd></div>
          <div><dt className="text-xs text-neutral-500">합성 생성</dt><dd>{r.syntheticPermitted ? '허용' : '불허'}</dd></div>
          <div><dt className="text-xs text-neutral-500">지역</dt><dd>{r.territories.join(', ') || '제한 없음'}</dd></div>
          <div><dt className="text-xs text-neutral-500">기간</dt><dd className="text-xs">{r.startsAt.slice(0, 10)} ~ {r.expiresAt?.slice(0, 10) ?? '무기한'}</dd></div>
          <div><dt className="text-xs text-neutral-500">등록</dt><dd className="text-xs">{r.createdAt.slice(0, 16).replace('T', ' ')}</dd></div>
        </dl>
      ) : current.isSuccess ? (
        <p className="mt-3 text-sm text-amber-500">등록된 권리 정보가 없어 캐스팅할 수 없습니다.</p>
      ) : null}

      {open ? (
        <div className="mt-4 space-y-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-neutral-500">권리자 (본인·소속사)
              <input className={inputCls} value={form.ownerName} onChange={(e) => set({ ownerName: e.target.value })} />
            </label>
            <label className="text-xs text-neutral-500">계약 번호 (선택)
              <input className={inputCls} value={form.contractRef} onChange={(e) => set({ contractRef: e.target.value })} />
            </label>
            <label className="text-xs text-neutral-500">동의 상태
              <select className={inputCls} value={form.consentStatus} onChange={(e) => set({ consentStatus: e.target.value })}>
                <option value="">선택하세요</option>
                {Object.entries(CONSENT_LABEL).map(([v, l]) => <option key={v} value={v}>{l} ({v})</option>)}
              </select>
            </label>
            <label className="text-xs text-neutral-500">합성 콘텐츠 생성
              <select className={inputCls} value={form.synthetic} onChange={(e) => set({ synthetic: e.target.value as 'yes' | 'no' })}>
                <option value="">선택하세요</option>
                <option value="yes">허용</option>
                <option value="no">불허</option>
              </select>
            </label>
            <label className="text-xs text-neutral-500">시작일
              <input type="date" className={inputCls} value={form.startsAt} onChange={(e) => set({ startsAt: e.target.value })} />
            </label>
            <label className="text-xs text-neutral-500">종료일 (비우면 무기한)
              <input type="date" className={inputCls} value={form.expiresAt} onChange={(e) => set({ expiresAt: e.target.value })} />
            </label>
            <label className="text-xs text-neutral-500">허용 지역 (쉼표 구분, 비우면 제한 없음)
              <input className={inputCls} value={form.territories} onChange={(e) => set({ territories: e.target.value })} />
            </label>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" checked={form.commercialUse} onChange={(e) => set({ commercialUse: e.target.checked })} />
              상업적 이용 허용
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(['allowedUsage', 'restrictedUsage'] as const).map((key) => (
              <fieldset key={key} className="text-xs text-neutral-500">
                <legend>{key === 'allowedUsage' ? '허용 용도 (비우면 제한 없음)' : '금지 용도'}</legend>
                <div className="mt-1 flex flex-wrap gap-3 text-sm text-neutral-800 dark:text-neutral-200">
                  {USAGE.map((u) => (
                    <label key={u} className="flex items-center gap-1">
                      <input type="checkbox" checked={form[key].includes(u)} onChange={(e) => toggle(key, u, e.target.checked)} />
                      {u}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <ErrorBox error={save.error} />
          <div className="flex items-center justify-end gap-3">
            {problems.length ? <span className="text-xs text-amber-500">입력 필요: {problems.join(', ')}</span> : null}
            <Button onClick={() => save.mutate()} disabled={problems.length > 0 || save.isPending}>
              {save.isPending ? '등록 중…' : '등록'}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
