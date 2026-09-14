'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { del, get, post } from '@/lib/api';
import { Badge, Button, Card, ErrorBox, Loading } from '@/components/ui';
import { RightsCard } from '@/components/rights-card';
import { uploadViaPresignedUrl } from '@/lib/upload';
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
  previewUrl: string | null;
  rejectReason: string | null;
  qualityDetail: Record<string, unknown> | null;
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

const SLOT_LABELS: Record<string, string> = {
  FRONT: '정면',
  LEFT_45: '왼쪽 45°',
  RIGHT_45: '오른쪽 45°',
  LEFT_90: '왼쪽 옆모습 90°',
  RIGHT_90: '오른쪽 옆모습 90°',
  UP: '위를 봄',
  DOWN: '아래를 봄',
  BODY_FRONT: '전신 정면',
  BODY_LEFT: '전신 왼쪽',
  BODY_RIGHT: '전신 오른쪽',
  BODY_BACK: '전신 뒷모습',
};
const OPTIONAL_SLOTS = ['UP', 'DOWN', 'BODY_LEFT', 'BODY_RIGHT', 'BODY_BACK'];
// SFace·YuNet은 OpenCV로 디코딩하므로 HEIC 같은 포맷은 받지 않는다.
const ACCEPT = 'image/jpeg,image/png,image/webp';

type AssetState = 'UPLOADING' | 'CHECKING' | 'USABLE' | 'EXCLUDED';

function assetState(a: AssetRow): AssetState {
  if (a.previewUrl === null && !a.isUsable && a.qualityScore === null) return 'UPLOADING';
  if (a.isUsable && a.qualityScore === null) return 'CHECKING';
  return a.isUsable ? 'USABLE' : 'EXCLUDED';
}

const STATE_BADGE: Record<AssetState, { label: string; className: string }> = {
  UPLOADING: { label: '업로드 미완료', className: 'bg-neutral-200 text-neutral-600' },
  CHECKING: { label: '품질 검사 중', className: 'bg-amber-100 text-amber-800' },
  USABLE: { label: '사용', className: 'bg-green-100 text-green-800' },
  EXCLUDED: { label: '제외', className: 'bg-red-100 text-red-700' },
};

const num = (v: unknown) => (typeof v === 'number' ? v : null);
const ratioPct = (v: unknown) => (num(v) === null ? '—' : `${Math.round((v as number) * 100)}%`);

/**
 * 제외 사유 — short는 썸네일 아래, long은 툴팁·표에 쓴다.
 * 수치와 기준은 워커가 판정 당시 남긴 quality_detail에서 읽는다(기준이 바뀌어도 당시 판정을 설명할 수 있다).
 */
function exclusionReason(a: AssetRow): { short: string; long: string } {
  const d = a.qualityDetail ?? {};
  switch (a.rejectReason) {
    case 'FACE_TOO_SMALL':
      return {
        short: '전신·반신 사진',
        long: `얼굴이 화면 세로의 ${ratioPct(d.faceHeightRatio)}뿐입니다. 얼굴 슬롯은 ${ratioPct(d.minFaceHeightRatio)} 이상이어야 합니다 — 얼굴 위주로 찍은 사진을 올리세요.`,
      };
    case 'NOT_FULL_BODY':
      return {
        short: '전신 아님',
        long: `전신이 화면에 ${ratioPct(d.bodyInFrameRatio)}만 들어왔습니다(기준 ${ratioPct(d.minBodyInFrame)}). 머리부터 발끝까지 나온 사진을 올리세요.`,
      };
    case 'BODY_FACE_MISSING':
      return { short: '얼굴 없음', long: '전신 정면 사진에서 얼굴을 찾지 못했습니다. 다른 부위만 찍힌 사진은 쓸 수 없습니다.' };
    case 'NO_FACE':
      return { short: '얼굴 미검출', long: '얼굴을 찾지 못했습니다. 얼굴이 가려지지 않은 사진을 올리세요.' };
    case 'PROCESSING_FAILED':
      return { short: '처리 실패', long: `이미지 처리에 실패했습니다${d.error ? ` (${String(d.error)})` : ''}. 재검사하거나 다시 올리세요.` };
    case 'LOW_QUALITY':
      return {
        short: `품질 미달 ${score(a.qualityScore)}`,
        long: `품질 ${score(a.qualityScore)}이 기준 ${score(num(d.minQuality))}에 못 미칩니다. 흐리거나 너무 어두운 사진인지 확인하세요.`,
      };
    case 'DEACTIVATED':
      return { short: '삭제됨(보존)', long: '삭제했지만 이미 프로파일 빌드에 쓰였을 수 있어 기록으로 보존합니다.' };
  }
  // 사유 컬럼 도입 전 판정 — 점수로만 추정한다
  if (a.qualityScore === 0) {
    const s = a.assetType === 'BODY_IMAGE' ? '처리 실패' : '얼굴 미검출';
    return { short: s, long: `${s} — 재검사하면 사유가 표시됩니다.` };
  }
  if (a.qualityScore !== null && a.qualityScore < 0.4) {
    return { short: `품질 미달 ${score(a.qualityScore)}`, long: '품질 기준 미달 — 재검사하면 사유가 표시됩니다.' };
  }
  return { short: '제외', long: '제외된 자산입니다.' };
}


export default function IdentityDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const profiles = useQuery({
    queryKey: ['identity-profiles', id],
    queryFn: () => get<ProfileRow[]>(`/identities/${id}/profiles`),
    // 빌드는 워커에서 비동기로 끝나므로 BUILDING인 동안만 다시 조회한다.
    refetchInterval: (q) => (q.state.data?.some((p) => p.status === 'BUILDING') ? 2000 : false),
  });
  const building = profiles.data?.some((p) => p.status === 'BUILDING') ?? false;

  const identity = useQuery({
    queryKey: ['identity', id],
    queryFn: () => get<{ displayName: string; code: string; status: string }>(`/identities/${id}`),
    refetchInterval: building ? 2000 : false,
  });
  const assets = useQuery({
    queryKey: ['identity-assets', id],
    queryFn: () => get<{ assets: AssetRow[]; coverage: Coverage }>(`/identities/${id}/assets`),
    // 품질 검사도 워커가 하므로 결과가 나올 때까지 다시 조회한다.
    refetchInterval: (q) => (q.state.data?.assets.some((a) => assetState(a) === 'CHECKING') ? 2000 : false),
  });

  const refreshAssets = () => qc.invalidateQueries({ queryKey: ['identity-assets', id] });

  // presigned URL 발급 → 스토리지 직접 업로드 → 확정(품질 검사 큐 투입) (§6.1, §15)
  const upload = useMutation({
    mutationFn: async ({ slot, files }: { slot: string; files: File[] }) => {
      for (const file of files) {
        const contentType = file.type || 'application/octet-stream';
        await uploadViaPresignedUrl({
          file, contentType,
          requestUrl: async () => {
            const r = await post<{ assetId: string; uploadUrl: string }>(`/identities/${id}/assets/upload-url`, {
              assetType: slot.startsWith('BODY_') ? 'BODY_IMAGE' : 'FACE_IMAGE',
              captureSlot: slot, contentType, fileName: file.name,
            });
            return { id: r.assetId, uploadUrl: r.uploadUrl };
          },
          confirm: (assetId, checksum) => post(`/identities/${id}/assets`, { assetId, checksum }),
        });
      }
    },
    onSettled: refreshAssets,
  });

  // 빌드에 쓰인 적 없는 자산은 실제로 지워지고, 쓰였을 수 있는 자산은 서버가 비활성화만 한다.
  const remove = useMutation({
    mutationFn: (assetId: string) => del<{ mode: 'DELETED' | 'DEACTIVATED' }>(`/identities/${id}/assets/${assetId}`),
    onSuccess: refreshAssets,
  });

  // 기준이 바뀌었거나 ML 오류로 실패한 자산을 다시 올리지 않고 현재 기준으로 다시 판정한다.
  const recheck = useMutation({
    mutationFn: () => post<{ queued: number; skipped: number }>(`/identities/${id}/assets/recheck`),
    onSuccess: refreshAssets,
  });

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

  // 캐스팅된 프로젝트가 있으면 서버가 어느 프로젝트인지 알려주며 거절한다
  const removeIdentity = useMutation({
    mutationFn: () => del<{ deletedObjects: number }>(`/identities/${id}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['identity', id] });
      qc.invalidateQueries({ queryKey: ['identities'] });
      qc.invalidateQueries({ queryKey: ['identities-all'] });
      router.push('/identities');
    },
  });
  const confirmRemoveIdentity = () => {
    const name = identity.data ? `${identity.data.code} ${identity.data.displayName}` : '이 인물';
    if (window.confirm(`'${name}'을(를) 삭제할까요?\n\n등록한 사진·임베딩·프로파일·권리 기록과 스토리지 파일이 모두 지워지며 되돌릴 수 없습니다. (감사 로그는 남습니다)`)) {
      removeIdentity.mutate();
    }
  };

  if (identity.isLoading) return <Loading />;
  const cov = assets.data?.coverage;
  const assetRows = assets.data?.assets ?? [];
  const checking = assetRows.filter((a) => assetState(a) === 'CHECKING').length;
  // 이미 비활성화된 자산은 프로파일이 있으면 서버가 더 지우지 않으므로 삭제 버튼을 감춘다.
  const hasProfile = (profiles.data ?? []).some((p) => ['BUILDING', 'ACTIVE', 'ARCHIVED'].includes(p.status));
  const removable = (a: AssetRow) => a.isUsable || !hasProfile;

  // 버튼이 왜 눌리지 않는지 옆에 적어 둔다.
  const buildBlocker = !cov
    ? null
    : !cov.buildable
    ? `필수 슬롯 ${cov.missingSlots.length}개 미충족`
    : checking > 0
    ? `품질 검사 중인 이미지 ${checking}장`
    : building
    ? '빌드 진행 중'
    : null;

  const slotTile = (slot: string, required: boolean) => {
    const slotAssets = assetRows.filter((a) => a.captureSlot === slot && a.previewUrl);
    const filled = cov?.filledSlots.includes(slot) ?? false;
    const busy = upload.isPending && upload.variables?.slot === slot;
    return (
      <div
        key={slot}
        className={`rounded-lg border p-3 ${
          filled ? 'border-green-700/60' : required ? 'border-amber-700/60' : 'border-neutral-200 dark:border-neutral-800'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">{SLOT_LABELS[slot] ?? slot}</div>
            <div className="font-mono text-[11px] text-neutral-500">{slot}</div>
          </div>
          {required ? (
            <Badge className={filled ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}>
              {filled ? '충족' : '필수'}
            </Badge>
          ) : null}
        </div>

        <div className="mt-3 flex min-h-16 flex-wrap gap-2">
          {slotAssets.length === 0 ? (
            <div className="text-xs text-neutral-500">이미지 없음</div>
          ) : (
            slotAssets.map((a) => {
              const st = assetState(a);
              return (
                <div
                  key={a.id}
                  className="relative w-16"
                  title={st === 'EXCLUDED' ? exclusionReason(a).long : `${STATE_BADGE[st].label} · 품질 ${score(a.qualityScore)}`}
                >
                  {removable(a) ? (
                    <button
                      type="button"
                      onClick={() => remove.mutate(a.id)}
                      disabled={remove.isPending}
                      aria-label={`${SLOT_LABELS[slot] ?? slot} 이미지 삭제`}
                      className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 text-xs leading-none text-white ring-1 ring-neutral-500 transition hover:bg-red-600 disabled:opacity-40"
                    >
                      ×
                    </button>
                  ) : null}
                  {/* presigned URL은 만료되는 외부 주소라 next/image 최적화 대상이 아니다 */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.previewUrl ?? ''}
                    alt={`${slot} 자산`}
                    className={`h-16 w-16 rounded object-cover ${st === 'EXCLUDED' ? 'opacity-30 grayscale' : ''}`}
                  />
                  <div
                    className={`mt-1 truncate text-center text-[10px] ${
                      st === 'USABLE' ? 'text-green-500' : st === 'CHECKING' ? 'text-amber-500' : 'text-red-500'
                    }`}
                  >
                    {st === 'CHECKING' ? '검사 중' : st === 'USABLE' ? score(a.qualityScore) : exclusionReason(a).short}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <label
          className={`mt-3 block rounded border border-neutral-300 px-3 py-1.5 text-center text-sm font-medium transition dark:border-neutral-700 ${
            upload.isPending ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800'
          }`}
        >
          {busy ? '업로드 중…' : '이미지 선택'}
          <input
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            disabled={upload.isPending}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = ''; // 같은 파일을 다시 골라도 onChange가 오도록 비운다
              if (files.length) upload.mutate({ slot, files });
            }}
          />
        </label>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="font-mono text-xs text-neutral-500">{identity.data?.code}</div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{identity.data?.displayName}</h1>
            {identity.data?.status ? (
              <Badge className={identity.data.status === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-neutral-200 text-neutral-700'}>
                {identity.data.status}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {buildBlocker ? <span className="text-xs text-neutral-500">{buildBlocker}</span> : null}
          <Button onClick={() => build.mutate()} disabled={buildBlocker !== null || build.isPending}>
            프로파일 빌드
          </Button>
          <Button variant="danger" onClick={confirmRemoveIdentity} disabled={removeIdentity.isPending || building}>
            {removeIdentity.isPending ? '삭제 중…' : '삭제'}
          </Button>
        </div>
      </div>

      <ErrorBox error={removeIdentity.error ?? upload.error ?? remove.error ?? recheck.error ?? build.error ?? activate.error} />

      {/* §6.1 캡처 슬롯 충족률 — 미충족이면 CREZ-IDN-001로 빌드가 거절된다 */}
      {cov ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium">캡처 슬롯 업로드</h2>
            <div className="flex items-center gap-3">
              <span className="text-sm text-neutral-500">
                {pct(cov.coverageRatio)} {cov.buildable ? '· 빌드 가능' : '· 빌드 불가'}
              </span>
              <Button
                variant="secondary"
                onClick={() => recheck.mutate()}
                disabled={recheck.isPending || building || assetRows.length === 0}
              >
                {recheck.isPending ? '재검사 요청 중…' : '현재 기준으로 재검사'}
              </Button>
            </div>
          </div>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-neutral-500">
            <li>얼굴 슬롯(정면·45°·90°): 얼굴 위주 사진 — 얼굴이 화면 세로의 15% 이상. 전신·반신 사진은 걸러집니다.</li>
            <li>전신 슬롯: 머리부터 발끝까지 나온 사진 — 전신 정면은 얼굴도 보여야 합니다.</li>
            <li>모두 같은 사람이어야 하며(섞이면 빌드가 CREZ-IDN-003으로 실패), 품질 0.4 이상만 사용됩니다. JPG·PNG·WEBP.</li>
          </ul>
          {recheck.data ? (
            <p className="mt-2 text-xs text-neutral-500">
              {recheck.data.queued}장을 다시 검사합니다{recheck.data.skipped ? ` · 직접 삭제한 ${recheck.data.skipped}장은 제외` : ''}.
            </p>
          ) : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[...cov.requiredFaceSlots, ...cov.requiredBodySlots].map((slot) => slotTile(slot, true))}
          </div>

          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-neutral-500">선택 슬롯 (충족률에 포함되지 않음)</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {OPTIONAL_SLOTS.map((slot) => slotTile(slot, false))}
            </div>
          </details>
        </Card>
      ) : null}

      <RightsCard identityId={id} />

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
                  <Badge
                    className={
                      p.status === 'ACTIVE' ? 'bg-green-100 text-green-800'
                      : p.status === 'FAILED' ? 'bg-red-100 text-red-700'
                      : p.status === 'BUILDING' ? 'bg-amber-100 text-amber-800'
                      : 'bg-neutral-200 text-neutral-600'
                    }
                  >
                    {p.status}
                  </Badge>
                </td>
                <td>{score(p.faceVariance)}</td>
                <td className="font-mono text-xs text-neutral-500">
                  {String((p.modelBundle as { faceEmbedder?: string })?.faceEmbedder ?? '—')}
                </td>
                <td className="text-xs text-neutral-500">{p.builtAt?.slice(0, 19).replace('T', ' ') ?? '—'}</td>
                <td className="text-right">
                  {p.status === 'ARCHIVED' ? (
                    <Button variant="secondary" onClick={() => activate.mutate(p.version)}>활성화</Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <h2 className="font-medium">자산 ({assetRows.length})</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr><th className="py-1">유형</th><th>슬롯</th><th>품질</th><th>상태</th><th>사유</th><th /></tr>
          </thead>
          <tbody>
            {assetRows.map((a) => {
              const st = assetState(a);
              return (
                <tr key={a.id} className="border-t border-neutral-100 dark:border-neutral-800">
                  <td className="py-2">{a.assetType}</td>
                  <td className="font-mono text-xs">{a.captureSlot ?? '—'}</td>
                  <td>{score(a.qualityScore)}</td>
                  <td className="whitespace-nowrap">
                    <Badge className={STATE_BADGE[st].className}>
                      {st === 'EXCLUDED' ? exclusionReason(a).short : STATE_BADGE[st].label}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 text-xs text-neutral-500">{st === 'EXCLUDED' ? exclusionReason(a).long : ''}</td>
                  <td className="text-right">
                    {removable(a) ? (
                      <Button variant="secondary" onClick={() => remove.mutate(a.id)} disabled={remove.isPending}>
                        삭제
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
