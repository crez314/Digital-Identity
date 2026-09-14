import type { AssetRejectReason } from '@crez/contracts';
import { ASSET_QUALITY_POLICY } from '@crez/shared';

/** ML 응답에서 판정에 필요한 측정값만 모은 것 — ML은 측정만 하고 판정은 여기서 한다(§2.2). */
export interface AssetMeasurement {
  assetType: 'FACE_IMAGE' | 'BODY_IMAGE';
  captureSlot: string | null;
  ok: boolean;
  error?: string | null;
  quality: number | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  /** 얼굴 슬롯: 선택된 얼굴 bbox 높이 / 신체 슬롯: 신체 영역을 유도한 얼굴 bbox 높이 */
  faceHeight?: number | null;
  detectionScore?: number | null;
  faceCount?: number | null;
  frontality?: number | null;
  /** 신체 슬롯 전용. 얼굴을 못 찾았으면 null */
  bodyInFrameRatio?: number | null;
}

export interface AssetVerdict {
  usable: boolean;
  reason: AssetRejectReason | null;
  /** identity_asset.quality_detail — 측정값과 당시 임계값 */
  detail: Record<string, number | string | boolean | null>;
}

const round = (v: number | null | undefined, digits = 4) =>
  v === null || v === undefined ? null : Number(v.toFixed(digits));

/**
 * 슬롯 적합성 → 품질 순으로 판정한다.
 * 슬롯에 맞지 않는 사진은 점수가 높아도 쓰면 안 되고, 사유도 그쪽이 더 행동 가능하므로 먼저 본다.
 */
export function judgeAsset(m: AssetMeasurement, policy = ASSET_QUALITY_POLICY): AssetVerdict {
  const detail: AssetVerdict['detail'] = {
    quality: round(m.quality),
    minQuality: policy.minQuality,
    imageWidth: m.imageWidth ?? null,
    imageHeight: m.imageHeight ?? null,
  };

  if (!m.ok) {
    detail.error = m.error ?? null;
    const reason = m.assetType === 'FACE_IMAGE' && m.error === 'no face detected' ? 'NO_FACE' : 'PROCESSING_FAILED';
    return { usable: false, reason, detail };
  }

  // 이미지 크기가 없으면(구버전 ML) 비율을 잴 수 없으므로 슬롯 적합성 판정을 건너뛴다.
  const measurable = !!m.imageHeight && m.imageHeight > 0;

  if (m.assetType === 'FACE_IMAGE') {
    const ratio = measurable && m.faceHeight ? m.faceHeight / (m.imageHeight as number) : null;
    Object.assign(detail, {
      faceHeightRatio: round(ratio),
      minFaceHeightRatio: policy.minFaceHeightRatio,
      detectionScore: round(m.detectionScore),
      faceCount: m.faceCount ?? null,
      frontality: round(m.frontality),
    });
    if (ratio !== null && ratio < policy.minFaceHeightRatio) {
      return { usable: false, reason: 'FACE_TOO_SMALL', detail };
    }
  } else {
    const faceFound = m.faceHeight !== null && m.faceHeight !== undefined;
    Object.assign(detail, {
      bodyInFrameRatio: round(m.bodyInFrameRatio),
      minBodyInFrame: policy.minBodyInFrame,
      faceFound: measurable ? faceFound : null,
    });
    if (measurable && faceFound && m.bodyInFrameRatio !== null && m.bodyInFrameRatio !== undefined
      && m.bodyInFrameRatio < policy.minBodyInFrame) {
      return { usable: false, reason: 'NOT_FULL_BODY', detail };
    }
    // 뒷모습·옆모습 슬롯은 얼굴이 없을 수 있지만, 전신 정면에서 얼굴이 없으면 다른 부위 사진이다.
    if (measurable && !faceFound && m.captureSlot === 'BODY_FRONT') {
      return { usable: false, reason: 'BODY_FACE_MISSING', detail };
    }
  }

  if ((m.quality ?? 0) < policy.minQuality) {
    return { usable: false, reason: 'LOW_QUALITY', detail };
  }
  return { usable: true, reason: null, detail };
}
