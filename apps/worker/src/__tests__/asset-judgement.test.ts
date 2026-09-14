import { describe, expect, it } from 'vitest';
import { judgeAsset, type AssetMeasurement } from '../lib/asset-judgement';

// 수치는 2026-09-11 실제 업로드 사진(2316x3088, 4284x5712)을 긴 변 640px로 검출한 측정값이다.
const face = (slot: string, faceHeightRatio: number, quality = 0.6): AssetMeasurement => ({
  assetType: 'FACE_IMAGE', captureSlot: slot, ok: true, quality,
  imageWidth: 2316, imageHeight: 3088, faceHeight: 3088 * faceHeightRatio, detectionScore: 0.7, faceCount: 1, frontality: 0.8,
});
const body = (slot: string, bodyInFrameRatio: number | null, quality = 0.9): AssetMeasurement => ({
  assetType: 'BODY_IMAGE', captureSlot: slot, ok: true, quality,
  imageWidth: 4284, imageHeight: 5712,
  faceHeight: bodyInFrameRatio === null ? null : 500, bodyInFrameRatio,
});

describe('자산 슬롯 적합성 판정 (§17 CREZ-IDN-002)', () => {
  it('얼굴 사진(얼굴 34~53%)은 얼굴 슬롯에서 사용한다 — 45° 측면도 포함', () => {
    expect(judgeAsset(face('FRONT', 0.35))).toMatchObject({ usable: true, reason: null });
    expect(judgeAsset(face('RIGHT_45', 0.458))).toMatchObject({ usable: true, reason: null });
    expect(judgeAsset(face('LEFT_45', 0.531))).toMatchObject({ usable: true, reason: null });
  });

  it('전신 사진(얼굴 9.7~11.5%)을 얼굴 슬롯에 올리면 걸러낸다', () => {
    const full = judgeAsset(face('FRONT', 0.097));
    expect(full).toMatchObject({ usable: false, reason: 'FACE_TOO_SMALL' });
    expect(full.detail).toMatchObject({ faceHeightRatio: 0.097, minFaceHeightRatio: 0.15 });
    expect(judgeAsset(face('RIGHT_45', 0.115))).toMatchObject({ usable: false, reason: 'FACE_TOO_SMALL' });
  });

  it('얼굴이 없는 사진(다른 부위)은 얼굴 슬롯에서 얼굴 미검출로 걸러낸다', () => {
    expect(judgeAsset({ assetType: 'FACE_IMAGE', captureSlot: 'FRONT', ok: false, error: 'no face detected', quality: null }))
      .toMatchObject({ usable: false, reason: 'NO_FACE' });
  });

  it('전신 사진(1.00)은 신체 슬롯에서 사용하고, 얼굴 사진(0.26~0.41)은 걸러낸다', () => {
    expect(judgeAsset(body('BODY_FRONT', 1.0))).toMatchObject({ usable: true, reason: null });
    expect(judgeAsset(body('BODY_FRONT', 0.41))).toMatchObject({ usable: false, reason: 'NOT_FULL_BODY' });
    expect(judgeAsset(body('BODY_FRONT', 0.26))).toMatchObject({ usable: false, reason: 'NOT_FULL_BODY' });
  });

  it('전신 정면 슬롯에서 얼굴이 없으면 다른 부위 사진으로 보고, 뒷모습 슬롯은 허용한다', () => {
    expect(judgeAsset(body('BODY_FRONT', null))).toMatchObject({ usable: false, reason: 'BODY_FACE_MISSING' });
    expect(judgeAsset(body('BODY_BACK', null))).toMatchObject({ usable: true, reason: null });
  });

  it('슬롯에 맞지 않으면 품질 점수가 높아도 그 사유를 먼저 알려준다', () => {
    expect(judgeAsset(face('FRONT', 0.08, 0.95)).reason).toBe('FACE_TOO_SMALL');
    expect(judgeAsset(face('FRONT', 0.2, 0.3)).reason).toBe('LOW_QUALITY');
  });

  it('이미지 크기를 모르면(구버전 ML) 비율 판정을 건너뛰고 품질만 본다', () => {
    const legacy: AssetMeasurement = { assetType: 'FACE_IMAGE', captureSlot: 'FRONT', ok: true, quality: 0.7, faceHeight: 50 };
    expect(judgeAsset(legacy)).toMatchObject({ usable: true, reason: null });
  });

  it('신체 인코더 오류는 처리 실패로 구분한다', () => {
    expect(judgeAsset({ assetType: 'BODY_IMAGE', captureSlot: 'BODY_FRONT', ok: false, error: '인코더 설정을 찾을 수 없습니다', quality: null }))
      .toMatchObject({ usable: false, reason: 'PROCESSING_FAILED' });
  });
});
