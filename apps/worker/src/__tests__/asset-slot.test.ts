import { describe, expect, it } from 'vitest';
import {
  classifyCaptureSlot, shouldClassifySlot, slotSignalsFromLandmarks, type SlotMeasurement,
} from '../lib/asset-slot';

/**
 * 2026-09-21 CRZ-A008 실측값을 그대로 고정한다. 사람이 붙인 라벨과 분류 결과가 같아야 한다.
 * 임계값을 건드리면 여기서 먼저 깨진다.
 */
const m = (over: Partial<SlotMeasurement>): SlotMeasurement => ({
  hasFace: true, faceHeightRatio: 0.4, bodyInFrameRatio: null,
  signedNoseOffset: 0, eyeDistanceRatio: 0.45, ...over,
});

describe('실측 사진 분류 (라벨과 일치해야 한다)', () => {
  it('FRONT — 코 오프셋 0.041 / 0.179', () => {
    expect(classifyCaptureSlot(m({ signedNoseOffset: 0.041, faceHeightRatio: 0.451 })).slot).toBe('FRONT');
    expect(classifyCaptureSlot(m({ signedNoseOffset: 0.179, faceHeightRatio: 0.350 })).slot).toBe('FRONT');
  });

  it('LEFT_45 — -0.523', () => {
    expect(classifyCaptureSlot(m({ signedNoseOffset: -0.523, eyeDistanceRatio: 0.356, faceHeightRatio: 0.531 })).slot)
      .toBe('LEFT_45');
  });

  it('RIGHT_45 — +0.722', () => {
    expect(classifyCaptureSlot(m({ signedNoseOffset: 0.722, eyeDistanceRatio: 0.255, faceHeightRatio: 0.458 })).slot)
      .toBe('RIGHT_45');
  });

  it('LEFT_90 — -2.388, 두 눈이 거의 겹친다', () => {
    expect(classifyCaptureSlot(m({ signedNoseOffset: -2.388, eyeDistanceRatio: 0.083, faceHeightRatio: 0.390 })).slot)
      .toBe('LEFT_90');
  });

  it('RIGHT_90 — +1.459', () => {
    expect(classifyCaptureSlot(m({ signedNoseOffset: 1.459, eyeDistanceRatio: 0.133, faceHeightRatio: 0.354 })).slot)
      .toBe('RIGHT_90');
  });

  it('BODY_FRONT — 얼굴은 화면의 8%뿐이고 전신이 들어왔다', () => {
    const g = classifyCaptureSlot(m({
      signedNoseOffset: 0.031, faceHeightRatio: 0.087, bodyInFrameRatio: 1.0, eyeDistanceRatio: 0.484,
    }));
    expect(g.slot).toBe('BODY_FRONT');
    expect(g.assetType).toBe('BODY_IMAGE');
  });
});

describe('방향', () => {
  it('음수는 왼쪽, 양수는 오른쪽이다', () => {
    expect(classifyCaptureSlot(m({ signedNoseOffset: -0.6 })).slot).toBe('LEFT_45');
    expect(classifyCaptureSlot(m({ signedNoseOffset: 0.6 })).slot).toBe('RIGHT_45');
  });

  it('전신 사진도 방향을 따른다', () => {
    expect(classifyCaptureSlot(m({ signedNoseOffset: -0.6, faceHeightRatio: 0.09, bodyInFrameRatio: 1 })).slot)
      .toBe('BODY_LEFT');
  });
});

describe('분류할 수 없는 경우', () => {
  it('얼굴이 없고 전신이 들어왔으면 뒷모습으로 보되 확인을 요청한다', () => {
    const g = classifyCaptureSlot(m({ hasFace: false, faceHeightRatio: null, bodyInFrameRatio: 1 }));
    expect(g.slot).toBe('BODY_BACK');
    expect(g.needsReview).toBe(true);
  });

  it('얼굴도 없고 전신도 아니면 분류하지 않는다', () => {
    expect(classifyCaptureSlot(m({ hasFace: false, faceHeightRatio: null, bodyInFrameRatio: 0.3 })).slot).toBeNull();
  });

  it('반신 사진은 분류하지 않는다 — 얼굴 슬롯엔 작고 전신 슬롯엔 잘렸다', () => {
    const g = classifyCaptureSlot(m({ faceHeightRatio: 0.10, bodyInFrameRatio: 0.5 }));
    expect(g.slot).toBeNull();
    expect(g.reason).toContain('전신도 다 들어오지 않아');
  });

  it('랜드마크가 없으면 각도를 판단하지 않는다', () => {
    expect(classifyCaptureSlot(m({ signedNoseOffset: null })).slot).toBeNull();
  });
});

describe('경계 표시', () => {
  it('정면과 45°의 경계에 가까우면 확인을 요청한다', () => {
    expect(classifyCaptureSlot(m({ signedNoseOffset: 0.29 })).needsReview).toBe(true);
    expect(classifyCaptureSlot(m({ signedNoseOffset: 0.05 })).needsReview).toBe(false);
  });
});

describe('랜드마크에서 신호 뽑기', () => {
  it('코가 오른쪽으로 치우치면 양수다', () => {
    const s = slotSignalsFromLandmarks([[100, 100], [200, 100], [180, 140], [120, 180], [180, 180]], 200);
    expect(s.signedNoseOffset).toBeCloseTo(0.3, 2);
    expect(s.eyeDistanceRatio).toBeCloseTo(0.5, 2);
  });

  it('랜드마크가 모자라면 null이다', () => {
    expect(slotSignalsFromLandmarks(null, 100).signedNoseOffset).toBeNull();
    expect(slotSignalsFromLandmarks([[0, 0]], 100).signedNoseOffset).toBeNull();
  });
});

/**
 * 재검사가 슬롯을 다시 보는 규칙.
 *
 * 사진을 한 슬롯(주로 정면)에 몰아 올린 뒤 재검사로 제자리에 보내는 것이 이 기능의 목적이다.
 * 동시에, 사람이 직접 옮긴 사진을 자동 분류가 되돌리면 "옮겨도 다시 돌아오는" 화면이 된다.
 */
describe('다시 분류할 대상 고르기', () => {
  const a = (over: Partial<Parameters<typeof shouldClassifySlot>[0]> = {}) => ({
    assetType: 'FACE_IMAGE', captureSlot: 'FRONT', ...over,
  });

  it('슬롯 없이 올린 사진은 언제나 분류한다', () => {
    expect(shouldClassifySlot(a({ assetType: 'UNSORTED', captureSlot: null }))).toBe(true);
    expect(shouldClassifySlot(a({ captureSlot: null }))).toBe(true);
  });

  it('평소 재검사는 이미 정해진 슬롯을 건드리지 않는다', () => {
    expect(shouldClassifySlot(a(), false)).toBe(false);
  });

  it('다시 분류를 요청하면 이미 정해진 슬롯도 다시 본다', () => {
    expect(shouldClassifySlot(a(), true)).toBe(true);
  });

  it('사람이 직접 옮긴 슬롯은 다시 분류해도 그대로 둔다', () => {
    expect(shouldClassifySlot(a({ qualityDetail: { manualSlot: true } }), true)).toBe(false);
  });

  it('영상 자산은 슬롯 개념이 없어 대상이 아니다', () => {
    expect(shouldClassifySlot(a({ assetType: 'VIDEO', captureSlot: null }), true)).toBe(false);
  });
});
