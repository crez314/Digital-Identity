export function ms(v: number): string {
  const total = Math.floor(v / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const cs = Math.floor((v % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function score(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : v.toFixed(3);
}

export const SEGMENT_COLORS: Record<string, string> = {
  PENDING: 'bg-neutral-300 text-neutral-800',
  GENERATING: 'bg-blue-500 text-white',
  QC: 'bg-amber-500 text-white',
  PASSED: 'bg-green-600 text-white',
  FAILED: 'bg-red-600 text-white',
  MANUAL_REVIEW: 'bg-violet-600 text-white',
};

export const SEVERITY_COLORS: Record<string, string> = {
  LOW: 'bg-yellow-200 text-yellow-900',
  MEDIUM: 'bg-orange-300 text-orange-900',
  HIGH: 'bg-red-400 text-white',
  CRITICAL: 'bg-red-700 text-white',
};

export const FINDING_LABELS: Record<string, string> = {
  IDENTITY_DRIFT: '신원 드리프트',
  IDENTITY_SWAP: '신원 교체',
  IDENTITY_BLEND: '신원 혼합',
  TRACK_LOST: '트랙 소실',
  FACE_ARTIFACT: '얼굴 아티팩트',
  HAND_ARTIFACT: '손 아티팩트',
  TEMPORAL_FLICKER: '플리커',
  COSTUME_INCONSISTENCY: '의상 불일치',
};
