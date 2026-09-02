import { describe, expect, it } from 'vitest';
import { embeddingVariance, percentile, seriesStats } from '../stats';
import { calibratedNormalizer, linearNormalizer, makeNormalizer } from '../normalize';
import { computeSeverity, labelFor, type SeverityThresholds, type SeverityWeights } from '../severity';
import { fuse, representativeIdentity, type FusionWeights } from '../fusion';
import { compare, cosineSimilarity, euclideanDistance, euclideanFromCosine } from '../distance';

/**
 * CREZ 자체 판정 계층 검증.
 * 이 테스트들은 특허 실시예의 실험 근거로 사용되므로, 각 항목이
 * 어떤 성질을 고정하는지 명시적으로 기술한다.
 */

const TH: SeverityThresholds = {
  faceSimilarityThreshold: 0.70,
  bodySimilarityThreshold: 0.65,
  faceTemporalDeltaThreshold: 0.18,
  bodyTemporalDeltaThreshold: 0.20,
  durationSaturationSec: 2.0,
};

const SW: SeverityWeights = {
  faceDrop: 0.35, bodyDrop: 0.20, faceInstability: 0.20, bodyInstability: 0.10, duration: 0.15,
};

const FW: FusionWeights = {
  faceIdentity: 0.40, bodyIdentity: 0.25, temporalFace: 0.15, temporalBody: 0.10, driftPenalty: 0.10,
};

describe('시계열 통계 (§10)', () => {
  it('하위 백분위가 짧고 치명적인 붕괴를 드러낸다', () => {
    // 평균은 높지만 15%의 구간이 무너진 영상
    const values = [...Array(85).fill(0.93), ...Array(15).fill(0.35)];
    const s = seriesStats(values);
    expect(s.mean).toBeGreaterThan(0.8);   // 평균만 보면 양호해 보인다
    expect(s.p05).toBeLessThan(0.5);        // 백분위가 붕괴를 드러낸다
    expect(s.p10).toBeLessThan(0.5);
    expect(s.min).toBeCloseTo(0.35, 2);
  });

  it('붕괴 구간이 백분위 경계와 정확히 겹치면 그 백분위만으로는 놓친다', () => {
    // 나쁜 프레임 비율이 백분위와 정확히 같으면, 보간이 좋은 값 쪽으로 당겨
    // 그 백분위는 붕괴를 놓친다. 5% 붕괴 → p05가, 10% 붕괴 → p10이 무뎌진다.
    // 따라서 단일 백분위로 임계 판정을 하면 안 되고 min을 함께 봐야 한다.
    const at5 = seriesStats([...Array(95).fill(0.93), ...Array(5).fill(0.35)]);
    expect(at5.p05).toBeGreaterThan(0.8);    // p05가 놓친다
    expect(at5.min).toBeCloseTo(0.35, 2);    // min은 놓치지 않는다

    const at10 = seriesStats([...Array(90).fill(0.93), ...Array(10).fill(0.35)]);
    expect(at10.p10).toBeGreaterThan(0.8);   // p10이 놓친다
    expect(at10.p05).toBeCloseTo(0.35, 2);   // 더 아래 백분위는 잡는다
  });

  it('백분위는 선형 보간한다', () => {
    expect(percentile([0, 10], 0.5)).toBe(5);
    expect(percentile([0, 100], 0.05)).toBe(5);
  });

  it('빈 시계열에서도 안전하게 동작한다', () => {
    const s = seriesStats([]);
    expect(s.count).toBe(0);
    expect(s.mean).toBe(0);
  });

  it('임베딩 분산이 흔들림을 수치화한다', () => {
    const stable = embeddingVariance([0.01, 0.011, 0.009, 0.01]);
    const jittery = embeddingVariance([0.01, 0.4, 0.02, 0.35]);
    expect(jittery).toBeGreaterThan(stable * 10);
  });
});

describe('0~100 정규화 (§5)', () => {
  it('코사인 유사도를 그대로 100배 하지 않는다', () => {
    const n = linearNormalizer({ floor: 0.2, ceiling: 0.9 });
    expect(n(0.5)).not.toBeCloseTo(50, 0);   // 단순 배수가 아님
    expect(n(0.2)).toBe(0);
    expect(n(0.9)).toBe(100);
  });

  it('범위를 벗어난 값을 클램프한다', () => {
    const n = linearNormalizer({ floor: 0.3, ceiling: 0.8 });
    expect(n(0.1)).toBe(0);
    expect(n(1.0)).toBe(100);
  });

  it('보정 곡선으로 교체할 수 있다 (검증셋 반영 경로)', () => {
    const n = calibratedNormalizer({
      floor: 0, ceiling: 1, curve: 'calibrated',
      controlPoints: [[0.3, 0], [0.6, 50], [0.75, 90], [0.9, 100]],
    });
    expect(n(0.6)).toBe(50);
    expect(n(0.75)).toBe(90);
    expect(n(0.675)).toBeGreaterThan(50);    // 제어점 사이는 보간
    expect(n(0.675)).toBeLessThan(90);
  });

  it('makeNormalizer가 curve 설정에 따라 구현을 고른다', () => {
    const linear = makeNormalizer({ floor: 0.2, ceiling: 0.9 });
    const cal = makeNormalizer({
      floor: 0.2, ceiling: 0.9, curve: 'calibrated',
      controlPoints: [[0.2, 0], [0.5, 80], [0.9, 100]],
    });
    expect(cal(0.5)).toBe(80);
    expect(linear(0.5)).not.toBe(80);
  });
});

describe('Drift Severity — 연속값 (§9)', () => {
  it('정상 구간은 severity 0이고 사유가 없다', () => {
    const r = computeSeverity(
      { faceSimilarity: 0.92, bodySimilarity: 0.88, faceDelta: 0.02, bodyDelta: 0.03, durationSec: 0 },
      TH, SW,
    );
    expect(r.severity).toBe(0);
    expect(r.reasons).toHaveLength(0);
    expect(r.label).toBe('LOW');
  });

  it('기준 대비 하락과 프레임 간 불안정을 구분해 사유로 남긴다', () => {
    // 기준과는 다르지만 안정적인 경우 — 캐스팅/조건 오류에 가깝다
    const drift = computeSeverity(
      { faceSimilarity: 0.40, bodySimilarity: 0.80, faceDelta: 0.02, bodyDelta: 0.02, durationSec: 0.5 },
      TH, SW,
    );
    expect(drift.reasons).toContain('face_similarity_drop');
    expect(drift.reasons).not.toContain('face_temporal_instability');

    // 기준과는 맞지만 프레임마다 튀는 경우 — 생성 불안정에 가깝다
    const unstable = computeSeverity(
      { faceSimilarity: 0.85, bodySimilarity: 0.80, faceDelta: 0.45, bodyDelta: 0.02, durationSec: 0.5 },
      TH, SW,
    );
    expect(unstable.reasons).toContain('face_temporal_instability');
    expect(unstable.reasons).not.toContain('face_similarity_drop');
  });

  it('지속시간이 severity를 증폭한다', () => {
    const base = { faceSimilarity: 0.45, bodySimilarity: 0.60, faceDelta: 0.05, bodyDelta: 0.05 };
    const brief = computeSeverity({ ...base, durationSec: 0.2 }, TH, SW);
    const sustained = computeSeverity({ ...base, durationSec: 3.0 }, TH, SW);
    expect(sustained.severity).toBeGreaterThan(brief.severity);
    expect(sustained.reasons).toContain('sustained_duration');
  });

  it('신체 신호가 없으면 가중치를 얼굴로 재분배한다', () => {
    // 신체를 0점 처리하면 신체 미검출이 곧 심각도로 둔갑한다
    const noBody = computeSeverity(
      { faceSimilarity: 0.92, bodySimilarity: null, faceDelta: 0.02, bodyDelta: null, durationSec: 0 },
      TH, SW,
    );
    expect(noBody.severity).toBe(0);
    expect(noBody.contributions.bodyDrop).toBe(0);
  });

  it('심각도가 클수록 상위 등급이 된다', () => {
    expect(labelFor(0.1)).toBe('LOW');
    expect(labelFor(0.3)).toBe('MEDIUM');
    expect(labelFor(0.6)).toBe('HIGH');
    expect(labelFor(0.9)).toBe('CRITICAL');
  });

  it('기여도를 남겨 판정 근거를 설명할 수 있다', () => {
    const r = computeSeverity(
      { faceSimilarity: 0.30, bodySimilarity: 0.30, faceDelta: 0.5, bodyDelta: 0.5, durationSec: 5 },
      TH, SW,
    );
    expect(r.severity).toBeGreaterThan(0.75);
    expect(Object.keys(r.contributions)).toContain('faceDrop');
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

describe('복합 점수 융합 (§11)', () => {
  const clean = {
    faceStats: seriesStats(Array(50).fill(0.93)),
    bodyStats: seriesStats(Array(50).fill(0.88)),
    temporalFace: 0.95,
    temporalBody: 0.92,
    drift: { driftFrames: 0, totalFrames: 50, maxSeverity: 0, averageSeverity: 0, maxDurationSec: 0 },
  };
  const nf = linearNormalizer({ floor: 0.2, ceiling: 0.95 });
  const nb = linearNormalizer({ floor: 0.2, ceiling: 0.95 });

  it('드리프트가 없으면 감점이 0이다', () => {
    const r = fuse(clean, FW, nf, nb);
    expect(r.driftPenalty).toBe(0);
    expect(r.finalScore).toBe(r.baseScore);
    expect(r.finalScore).toBeGreaterThan(80);
  });

  it('드리프트는 가중합이 아니라 감점으로 작동한다', () => {
    const withDrift = fuse(
      { ...clean, drift: { driftFrames: 6, totalFrames: 50, maxSeverity: 0.9, averageSeverity: 0.7, maxDurationSec: 3 } },
      FW, nf, nb,
    );
    // 평균 지표는 그대로인데 최종 점수만 떨어져야 한다
    expect(withDrift.baseScore).toBe(fuse(clean, FW, nf, nb).baseScore);
    expect(withDrift.driftPenalty).toBeGreaterThan(0);
    expect(withDrift.finalScore).toBeLessThan(withDrift.baseScore);
  });

  it('평균이 같아도 하위 구간이 무너지면 점수가 낮다', () => {
    const flat = seriesStats(Array(100).fill(0.85));
    const spiky = seriesStats([...Array(90).fill(0.885), ...Array(10).fill(0.535)]);
    expect(flat.mean).toBeCloseTo(spiky.mean, 2);   // 평균은 사실상 동일

    const a = fuse({ ...clean, faceStats: flat }, FW, nf, nb);
    const b = fuse({ ...clean, faceStats: spiky }, FW, nf, nb);
    expect(b.finalScore).toBeLessThan(a.finalScore);  // 하위 백분위가 반영된다
  });

  it('신체 신호가 없으면 가중치를 재분배하고 그 사실을 표시한다', () => {
    const r = fuse({ ...clean, bodyStats: null, temporalBody: null }, FW, nf, nb);
    expect(r.bodySignalAvailable).toBe(false);
    expect(r.bodyIdentityScore).toBeNull();
    // 신체 미검출이 곧 감점이 되어서는 안 된다
    expect(r.finalScore).toBeGreaterThan(80);
  });

  it('최종 점수는 0~100 범위를 벗어나지 않는다', () => {
    const catastrophic = fuse(
      {
        faceStats: seriesStats(Array(50).fill(0.1)),
        bodyStats: seriesStats(Array(50).fill(0.1)),
        temporalFace: 0.05, temporalBody: 0.05,
        drift: { driftFrames: 50, totalFrames: 50, maxSeverity: 1, averageSeverity: 1, maxDurationSec: 30 },
      },
      FW, nf, nb,
    );
    expect(catastrophic.finalScore).toBeGreaterThanOrEqual(0);
    expect(catastrophic.finalScore).toBeLessThanOrEqual(100);
  });

  it('대표 일치도는 평균과 하위 백분위를 섞는다', () => {
    const s = seriesStats([...Array(90).fill(0.9), ...Array(10).fill(0.4)]);
    expect(representativeIdentity(s, 0)).toBeCloseTo(s.mean, 4);
    expect(representativeIdentity(s, 1)).toBeCloseTo(s.p05, 4);
    const mixed = representativeIdentity(s, 0.3);
    expect(mixed).toBeLessThan(s.mean);
    expect(mixed).toBeGreaterThan(s.p05);
  });
});

describe('거리 지표 (§6)', () => {
  it('정규화 벡터에서 유클리드 거리와 코사인은 대응한다', () => {
    const a = [0.6, 0.8, 0, 0];
    const b = [0.8, 0.6, 0, 0];
    const cos = cosineSimilarity(a, b);
    expect(euclideanDistance(a, b)).toBeCloseTo(euclideanFromCosine(cos), 5);
  });

  it('동일 벡터는 거리 0, 유사도 1', () => {
    const v = [0.5, 0.5, 0.5, 0.5];
    const d = compare(v, v);
    expect(d.cosine).toBeCloseTo(1, 6);
    expect(d.euclidean).toBeCloseTo(0, 6);
  });

  it('직교 벡터는 유사도 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('길이가 다르면 안전하게 처리한다', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(euclideanDistance([1, 2], [1, 2, 3])).toBe(Number.POSITIVE_INFINITY);
  });
});
