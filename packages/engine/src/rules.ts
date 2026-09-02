import type { FindingType, QcThresholds } from '@crez/contracts';
import { clamp01, round } from './scoring';

/**
 * §10.2 오류 패턴 탐지 규칙.
 *
 * 판정은 프레임 단위가 아니라 track 단위 컨텍스트 위에서 이뤄진다(§9.2).
 * 프레임별 독립 판정은 노이즈가 커서 오탐이 폭증하므로, 모든 규칙은
 * "조건이 최소 지속시간 이상 유지될 것"을 요구한다.
 *
 * 각 finding은 근거(프레임 인덱스·유사도 시계열·baseline)를 반드시 포함한다.
 * 근거 없는 finding은 운영자가 검증할 수 없어 QC 신뢰도를 떨어뜨린다.
 */

export interface SeriesPoint {
  ms: number;
  similarity: number;
  runnerUpSimilarity: number | null;
  runnerUpIdentityId: string | null;
  nearestIdentityId: string | null;
  trackIndex: number | null;
  frameQuality: number;
  occlusion: number;
  embeddingDelta: number | null;
}

export interface TrackSpan {
  trackIndex: number;
  startMs: number;
  endMs: number;
  assigned: boolean;
}

export interface IdentitySeries {
  identityId: string;
  series: SeriesPoint[];
  trackSpans: TrackSpan[];
}

export interface DetectedFinding {
  identityId: string | null;
  findingType: FindingType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
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

const SLIDING_WINDOW_MS = 1000; // §10.2 "슬라이딩 윈도우(1초)"

/** 유효 프레임 — 품질 미달이나 심한 가림은 판정에서 제외 (§9.2 모션 블러/가림 처리) */
function isValid(p: SeriesPoint, th: QcThresholds): boolean {
  return p.frameQuality >= th.minFrameQuality && p.occlusion < 0.6;
}

/** 조건을 만족하는 연속 구간을 뽑아낸다. 최소 지속시간 미달 구간은 버린다. */
function runs(points: SeriesPoint[], pred: (p: SeriesPoint) => boolean, minDurationMs: number) {
  const out: Array<{ start: number; end: number; idx: number[] }> = [];
  let cur: { start: number; end: number; idx: number[] } | null = null;
  points.forEach((p, i) => {
    if (pred(p)) {
      if (!cur) cur = { start: p.ms, end: p.ms, idx: [i] };
      else { cur.end = p.ms; cur.idx.push(i); }
    } else if (cur) {
      if (cur.end - cur.start >= minDurationMs) out.push(cur);
      cur = null;
    }
  });
  if (cur && (cur as { start: number; end: number }).end - (cur as { start: number; end: number }).start >= minDurationMs) out.push(cur);
  return out;
}

function severityFor(ratio: number): DetectedFinding['severity'] {
  if (ratio >= 3) return 'CRITICAL';
  if (ratio >= 2) return 'HIGH';
  if (ratio >= 1.3) return 'MEDIUM';
  return 'LOW';
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 슬라이딩 윈도우 평균 유사도 */
function windowMean(points: SeriesPoint[], centerIdx: number, windowMs: number): number {
  const c = points[centerIdx];
  const inWindow = points.filter((p) => Math.abs(p.ms - c.ms) <= windowMs / 2);
  if (inWindow.length === 0) return c.similarity;
  return inWindow.reduce((s, p) => s + p.similarity, 0) / inWindow.length;
}

/**
 * IDENTITY_DRIFT — 윈도우 평균이 세그먼트 baseline 대비 일정폭 이상 하락한 상태가 N초 이상 지속.
 * baseline은 상위 유사도 구간의 중앙값으로 잡는다(초반 몇 프레임에 좌우되지 않게).
 */
export function detectDrift(s: IdentitySeries, th: QcThresholds): DetectedFinding[] {
  const valid = s.series.filter((p) => isValid(p, th));
  if (valid.length < 5) return [];

  const sorted = [...valid].map((p) => p.similarity).sort((a, b) => b - a);
  const baseline = median(sorted.slice(0, Math.max(3, Math.ceil(sorted.length * 0.3))));
  const floor = baseline * (1 - th.driftDropRatio);

  const smoothed = valid.map((p, i) => ({ ...p, similarity: windowMean(valid, i, SLIDING_WINDOW_MS) }));
  const spans = runs(smoothed, (p) => p.similarity < floor, th.driftMinDurationSec * 1000);

  return spans.map((span) => {
    const vals = span.idx.map((i) => smoothed[i].similarity);
    const worst = Math.min(...vals);
    const drop = baseline > 0 ? (baseline - worst) / baseline : 0;
    return {
      identityId: s.identityId,
      findingType: 'IDENTITY_DRIFT' as FindingType,
      severity: severityFor(drop / th.driftDropRatio),
      startMs: span.start,
      endMs: span.end,
      confidence: round(clamp01(drop / Math.max(th.driftDropRatio, 1e-6) / 3)),
      evidence: {
        frameIndices: span.idx.map((i) => valid[i].ms),
        similaritySeries: vals.map((v) => round(v)),
        baseline: round(baseline),
        note: `baseline ${round(baseline)} 대비 최저 ${round(worst)} (하락률 ${round(drop)})`,
      },
    };
  });
}

/**
 * IDENTITY_SWAP — track 연속성이 유지되는데 프레임 단위 최근접 identity가
 * 다른 캐스트로 전환되고 유지됨. track이 끊긴 지점의 전환은 SWAP이 아니라
 * 재할당이므로 제외한다(§9.2 완전 가림 후 재등장).
 */
export function detectSwap(s: IdentitySeries, th: QcThresholds): DetectedFinding[] {
  const valid = s.series.filter((p) => isValid(p, th) && p.nearestIdentityId !== null);
  if (valid.length < 3) return [];

  const out: DetectedFinding[] = [];
  const wrong = (p: SeriesPoint) => p.nearestIdentityId !== s.identityId;

  for (const span of runs(valid, wrong, th.swapMinDurationSec * 1000)) {
    const first = valid[span.idx[0]];
    const prevIdx = span.idx[0] - 1;
    const prev = prevIdx >= 0 ? valid[prevIdx] : null;
    // track이 유지된 상태에서의 전환만 SWAP으로 본다
    const trackContinuous = prev !== null && prev.trackIndex !== null && prev.trackIndex === first.trackIndex;
    if (!trackContinuous) continue;

    const takeover = valid[span.idx[0]].nearestIdentityId;
    const durationSec = (span.end - span.start) / 1000;
    out.push({
      identityId: s.identityId,
      findingType: 'IDENTITY_SWAP',
      severity: severityFor(durationSec / Math.max(th.swapMinDurationSec, 1e-6)),
      startMs: span.start,
      endMs: span.end,
      confidence: round(clamp01(durationSec / Math.max(th.swapMinDurationSec * 3, 1e-6))),
      evidence: {
        frameIndices: span.idx.map((i) => valid[i].ms),
        similaritySeries: span.idx.map((i) => round(valid[i].similarity)),
        note: `track ${first.trackIndex} 연속 유지 중 최근접 identity가 ${takeover}로 전환되어 ${round(durationSec, 2)}초 유지`,
      },
    });
  }
  return out;
}

/** IDENTITY_BLEND — 1·2순위 유사도 차가 margin 미만인 구간이 지속 */
export function detectBlend(s: IdentitySeries, th: QcThresholds): DetectedFinding[] {
  const valid = s.series.filter((p) => isValid(p, th) && p.runnerUpSimilarity !== null);
  if (valid.length < 3) return [];

  const ambiguous = (p: SeriesPoint) =>
    p.runnerUpSimilarity !== null && Math.abs(p.similarity - p.runnerUpSimilarity) < th.blendMargin;

  return runs(valid, ambiguous, th.blendMinDurationSec * 1000).map((span) => {
    const margins = span.idx.map((i) => Math.abs(valid[i].similarity - (valid[i].runnerUpSimilarity ?? 0)));
    const tightest = Math.min(...margins);
    return {
      identityId: s.identityId,
      findingType: 'IDENTITY_BLEND' as FindingType,
      severity: severityFor(th.blendMargin / Math.max(tightest, 1e-6)),
      startMs: span.start,
      endMs: span.end,
      confidence: round(clamp01(1 - tightest / Math.max(th.blendMargin, 1e-6))),
      evidence: {
        frameIndices: span.idx.map((i) => valid[i].ms),
        similaritySeries: span.idx.map((i) => round(valid[i].similarity)),
        note: `1·2순위 최소 margin ${round(tightest)} < ${th.blendMargin} (경쟁 identity ${valid[span.idx[0]].runnerUpIdentityId})`,
      },
    };
  });
}

/**
 * TRACK_LOST — 가림으로 설명되지 않는 구간에서 캐스트 track이 소실.
 * occlusion이 높은 구간은 정상적인 가림이므로 제외한다.
 */
export function detectTrackLost(s: IdentitySeries, th: QcThresholds): DetectedFinding[] {
  const lost = (p: SeriesPoint) => p.trackIndex === null && p.occlusion < 0.5;
  return runs(s.series, lost, th.trackLostMinDurationSec * 1000).map((span) => {
    const durationSec = (span.end - span.start) / 1000;
    return {
      identityId: s.identityId,
      findingType: 'TRACK_LOST' as FindingType,
      severity: severityFor(durationSec / Math.max(th.trackLostMinDurationSec, 1e-6)),
      startMs: span.start,
      endMs: span.end,
      confidence: round(clamp01(durationSec / Math.max(th.trackLostMinDurationSec * 3, 1e-6))),
      evidence: {
        frameIndices: span.idx.map((i) => s.series[i].ms),
        note: `가림으로 설명되지 않는 track 소실 ${round(durationSec, 2)}초`,
      },
    };
  });
}

/** TEMPORAL_FLICKER — 임베딩 변화량이 주기적으로 급등 (z-score 기준) */
export function detectFlicker(s: IdentitySeries, th: QcThresholds): DetectedFinding[] {
  const valid = s.series.filter((p) => isValid(p, th) && p.embeddingDelta !== null);
  if (valid.length < 8) return [];

  const deltas = valid.map((p) => p.embeddingDelta as number);
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const sd = Math.sqrt(deltas.reduce((s2, d) => s2 + (d - mean) ** 2, 0) / deltas.length);
  if (sd === 0) return [];

  const spikeIdx = deltas
    .map((d, i) => ({ z: (d - mean) / sd, i }))
    .filter((x) => x.z > th.flickerZScore)
    .map((x) => x.i);

  // 단발 스파이크는 노이즈. 급등이 3회 이상 반복될 때만 플리커로 본다.
  if (spikeIdx.length < 3) return [];

  const startMs = valid[spikeIdx[0]].ms;
  const endMs = valid[spikeIdx[spikeIdx.length - 1]].ms;
  const maxZ = Math.max(...spikeIdx.map((i) => (deltas[i] - mean) / sd));
  return [{
    identityId: s.identityId,
    findingType: 'TEMPORAL_FLICKER',
    severity: severityFor(maxZ / Math.max(th.flickerZScore, 1e-6)),
    startMs,
    endMs,
    confidence: round(clamp01(spikeIdx.length / Math.max(valid.length * 0.2, 1))),
    evidence: {
      frameIndices: spikeIdx.map((i) => valid[i].ms),
      similaritySeries: spikeIdx.map((i) => round(valid[i].similarity)),
      note: `임베딩 변화량 z>${th.flickerZScore} 스파이크 ${spikeIdx.length}회 (최대 z=${round(maxZ, 2)})`,
    },
  }];
}

/** 한 인물에 대한 전체 규칙 적용 */
export function detectAll(s: IdentitySeries, th: QcThresholds): DetectedFinding[] {
  return [
    ...detectDrift(s, th),
    ...detectSwap(s, th),
    ...detectBlend(s, th),
    ...detectTrackLost(s, th),
    ...detectFlicker(s, th),
  ].sort((a, b) => a.startMs - b.startMs);
}
