import { describe, expect, it } from 'vitest';
import { detectAll, detectBlend, detectDrift, detectFlicker, detectSwap, detectTrackLost } from '../rules';
import { TH, series } from './fixtures';

const mk = (points: ReturnType<typeof series>) => ({ identityId: 'me', series: points, trackSpans: [] });

describe('QC 규칙 엔진 (§10.2)', () => {
  it('DRIFT: baseline 대비 지속 하락을 잡는다', () => {
    // 0–3초 정상(0.92), 3–6초 하락(0.70)
    const s = mk(series(30, (i) => ({ similarity: i < 15 ? 0.92 : 0.7 })));
    const f = detectDrift(s, TH);
    expect(f).toHaveLength(1);
    expect(f[0].findingType).toBe('IDENTITY_DRIFT');
    expect(f[0].endMs - f[0].startMs).toBeGreaterThanOrEqual(1000);
    expect(f[0].evidence.baseline).toBeGreaterThan(0.9);
    expect(f[0].evidence.frameIndices?.length).toBeGreaterThan(0);
  });

  it('DRIFT: 최소 지속시간 미만의 순간 하락은 무시한다 (오탐 억제)', () => {
    const s = mk(series(30, (i) => ({ similarity: i === 15 ? 0.5 : 0.92 })));
    expect(detectDrift(s, TH)).toHaveLength(0);
  });

  it('DRIFT: 품질 미달 프레임은 판정에서 제외한다', () => {
    const s = mk(series(30, (i) => (i >= 15 ? { similarity: 0.4, frameQuality: 0.1 } : { similarity: 0.92 })));
    expect(detectDrift(s, TH)).toHaveLength(0);
  });

  it('SWAP: track 연속 상태에서 최근접 identity가 바뀌어 유지되면 잡는다', () => {
    const s = mk(series(30, (i) => (i >= 10 && i < 20 ? { nearestIdentityId: 'other' } : {})));
    const f = detectSwap(s, TH);
    expect(f).toHaveLength(1);
    expect(f[0].findingType).toBe('IDENTITY_SWAP');
    expect(f[0].evidence.note).toContain('other');
  });

  it('SWAP: track이 끊긴 뒤의 전환은 재할당이므로 SWAP이 아니다 (§9.2)', () => {
    const s = mk(series(30, (i) => {
      if (i >= 10 && i < 20) return { nearestIdentityId: 'other', trackIndex: 1 };
      return { trackIndex: i < 10 ? 0 : 2 };
    }));
    expect(detectSwap(s, TH)).toHaveLength(0);
  });

  it('BLEND: 1·2순위 차가 margin 미만인 구간이 지속되면 잡는다', () => {
    const s = mk(series(30, (i) => (i >= 10 && i < 20 ? { similarity: 0.6, runnerUpSimilarity: 0.58 } : {})));
    const f = detectBlend(s, TH);
    expect(f).toHaveLength(1);
    expect(f[0].findingType).toBe('IDENTITY_BLEND');
  });

  it('TRACK_LOST: 가림으로 설명되는 소실은 제외한다', () => {
    const occluded = mk(series(30, (i) => (i >= 10 && i < 20 ? { trackIndex: null, occlusion: 0.9 } : {})));
    expect(detectTrackLost(occluded, TH)).toHaveLength(0);

    const unexplained = mk(series(30, (i) => (i >= 10 && i < 20 ? { trackIndex: null, occlusion: 0.1 } : {})));
    expect(detectTrackLost(unexplained, TH)).toHaveLength(1);
  });

  it('FLICKER: 단발 스파이크는 무시하고 반복 급등만 잡는다', () => {
    const single = mk(series(40, (i) => ({ embeddingDelta: i === 20 ? 0.9 : 0.01 })));
    expect(detectFlicker(single, TH)).toHaveLength(0);

    const repeated = mk(series(40, (i) => ({ embeddingDelta: i % 7 === 0 && i > 0 ? 0.5 : 0.01 })));
    expect(detectFlicker(repeated, TH).length).toBeGreaterThanOrEqual(1);
  });

  it('정상 영상에서는 finding이 나오지 않는다 (오탐률 §20)', () => {
    const clean = mk(series(50, (i) => ({ similarity: 0.9 + Math.sin(i) * 0.01, embeddingDelta: 0.01 + (i % 3) * 0.001 })));
    expect(detectAll(clean, TH)).toHaveLength(0);
  });

  it('모든 finding은 근거를 포함한다 (§10.2)', () => {
    const s = mk(series(30, (i) => ({ similarity: i < 15 ? 0.92 : 0.6 })));
    for (const f of detectAll(s, TH)) {
      expect(f.evidence).toBeDefined();
      expect(Object.keys(f.evidence).length).toBeGreaterThan(0);
      expect(f.confidence).toBeGreaterThan(0);
    }
  });
});
