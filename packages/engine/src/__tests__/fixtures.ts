import type { QcThresholds } from '@crez/contracts';
import type { SeriesPoint } from '../rules';

export const TH: QcThresholds = {
  perIdentityMin: 0.85,
  maxSpread: 0.12,
  overallMin: 0.9,
  driftDropRatio: 0.12,
  driftMinDurationSec: 1.0,
  blendMargin: 0.05,
  blendMinDurationSec: 0.6,
  swapMinDurationSec: 0.8,
  flickerZScore: 2.5,
  trackLostMinDurationSec: 0.5,
  minFrameQuality: 0.35,
};

/** 200ms 간격 시계열 생성기 */
export function series(
  n: number,
  fn: (i: number, ms: number) => Partial<SeriesPoint>,
  stepMs = 200,
): SeriesPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const ms = i * stepMs;
    return {
      ms,
      similarity: 0.9,
      runnerUpSimilarity: 0.4,
      runnerUpIdentityId: 'other',
      nearestIdentityId: 'me',
      trackIndex: 0,
      frameQuality: 0.8,
      occlusion: 0.0,
      embeddingDelta: 0.01,
      ...fn(i, ms),
    };
  });
}
