import { ASSET_QUALITY_POLICY } from '@crez/shared';

/**
 * 캡처 슬롯 자동 분류 (§8.1 확장).
 *
 * 사람이 사진마다 슬롯을 고르게 하면 수십·수백 장을 올릴 수 없다. 측정값으로 분류한다.
 * ML은 측정만 하고 분류는 여기서 한다(§2.2) — 기준이 바뀌어도 ML을 다시 배포하지 않는다.
 *
 * 쓰는 신호는 셋이다.
 *  · 코가 두 눈 중점에서 얼마나 벗어났나(눈 간격으로 정규화) — 고개를 돌린 정도와 **방향**
 *  · 두 눈 간격 / 얼굴 폭 — 옆모습일수록 두 눈이 겹쳐 작아진다
 *  · 얼굴 높이 / 화면 세로 — 얼굴 사진인지 전신 사진인지
 *
 * 임계값 근거 (2026-09-21, CRZ-A008 실측 11장. 슬롯은 업로드 시 사람이 붙인 라벨):
 *
 *   슬롯          코-눈중점/눈간격   눈간격/얼굴폭   얼굴/화면세로
 *   BODY_FRONT×5   0.015 ~ 0.089       0.457~0.488     0.084~0.088
 *   FRONT×2        0.041, 0.179        0.436, 0.457    0.350, 0.451
 *   LEFT_45       -0.523               0.356           0.531
 *   RIGHT_45      +0.722               0.255           0.458
 *   LEFT_90       -2.388               0.083           0.390
 *   RIGHT_90      +1.459               0.133           0.354
 *
 * 정면(최대 0.179)과 45°(최소 0.523) 사이, 45°(최대 0.722)와 90°(최소 1.459) 사이가 넉넉히 벌어져
 * 그 중간을 임계값으로 잡았다. 부호가 방향을 준다 — 음수는 LEFT, 양수는 RIGHT다.
 *
 * **표본이 각도별 1장씩인 잠정값이다.** 촬영 기기·화각이 달라지면 재측정해야 하며,
 * 경계에 가까운 사진은 needsReview로 표시해 사람이 확인하게 한다.
 */

export const SLOT_CLASSIFIER_POLICY = {
  /** |코-눈중점/눈간격| 이 값 미만이면 정면 */
  frontMaxOffset: 0.3,
  /** 이 값 이상이면 완전 측면(90°) */
  profileMinOffset: 1.0,
  /** 눈 간격/얼굴 폭이 이 값 미만이면 옆모습 쪽으로 본다 — 부호 신호를 보강한다 */
  profileMaxEyeRatio: 0.2,
  /** 경계에서 이 비율 안쪽이면 사람이 확인하도록 표시한다 */
  reviewBandRatio: 0.25,
} as const;

/**
 * 이 사진의 슬롯을 (다시) 분류해야 하는가.
 *
 * 세 경우에 분류한다.
 *  · UNSORTED — 슬롯 없이 한꺼번에 올린 사진
 *  · 이미지인데 슬롯이 비었다 — 이전 분류가 실패했거나 예전 데이터
 *  · 재검사인데 사람이 정한 슬롯이 아니다 — 한 슬롯에 몰아 올린 사진을 제자리로 보낸다
 *
 * 사람이 직접 옮긴 슬롯(manualSlot)은 재검사에서도 건드리지 않는다. 자동 분류가 사람의
 * 판단을 되돌리면 고쳐 놓을 방법이 없다 — 옮기면 다시 돌아오는 화면이 된다.
 * 영상 자산은 슬롯 개념이 없어 대상이 아니다.
 */
export function shouldClassifySlot(
  asset: { assetType: string; captureSlot: string | null; qualityDetail?: unknown },
  reclassify = false,
): boolean {
  if (asset.assetType === 'UNSORTED') return true;
  const isImage = asset.assetType === 'FACE_IMAGE' || asset.assetType === 'BODY_IMAGE';
  if (!isImage) return false;
  if (!asset.captureSlot) return true;
  const manual = (asset.qualityDetail as { manualSlot?: boolean } | null)?.manualSlot === true;
  return reclassify && !manual;
}

export interface SlotMeasurement {
  /** 얼굴을 찾았는가 */
  hasFace: boolean;
  /** 얼굴 bbox 높이 / 이미지 세로 */
  faceHeightRatio: number | null;
  /** 추정 전신 중 화면에 들어온 비율. 얼굴이 없으면 null */
  bodyInFrameRatio: number | null;
  /** (코.x − 두눈중점.x) / 두눈간격. 음수 왼쪽, 양수 오른쪽 */
  signedNoseOffset: number | null;
  /** 두 눈 간격 / 얼굴 폭 */
  eyeDistanceRatio: number | null;
}

export type Yaw = 'FRONT' | 'LEFT_45' | 'RIGHT_45' | 'LEFT_90' | 'RIGHT_90';

export interface SlotGuess {
  /** 분류한 슬롯. 판단할 근거가 없으면 null */
  slot: string | null;
  /** 얼굴 사진인지 전신 사진인지 */
  assetType: 'FACE_IMAGE' | 'BODY_IMAGE' | null;
  /** 경계에 가까워 사람이 확인해야 하는가 */
  needsReview: boolean;
  /** 왜 이렇게 분류했는지 — 화면에 그대로 보여 준다 */
  reason: string;
  /** 판단에 쓴 측정값과 임계값 */
  detail: Record<string, number | string | boolean | null>;
}

const round = (v: number | null | undefined, d = 4) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d));

/** 고개를 돌린 정도와 방향 */
function classifyYaw(
  offset: number,
  eyeRatio: number | null,
  p = SLOT_CLASSIFIER_POLICY,
): { yaw: Yaw; needsReview: boolean } {
  const side = offset < 0 ? 'LEFT' : 'RIGHT';
  const mag = Math.abs(offset);

  // 두 눈이 거의 겹쳐 보이면 옆모습이다. 부호만으로 애매한 구간을 보강한다.
  const looksProfile = eyeRatio !== null && eyeRatio < p.profileMaxEyeRatio;

  if (mag >= p.profileMinOffset || looksProfile) {
    return { yaw: `${side}_90` as Yaw, needsReview: mag < p.profileMinOffset };
  }
  if (mag < p.frontMaxOffset) {
    return { yaw: 'FRONT', needsReview: mag > p.frontMaxOffset * (1 - p.reviewBandRatio) };
  }
  const near = mag < p.frontMaxOffset * (1 + p.reviewBandRatio)
    || mag > p.profileMinOffset * (1 - p.reviewBandRatio);
  return { yaw: `${side}_45` as Yaw, needsReview: near };
}

/**
 * 사진 한 장을 캡처 슬롯으로 분류한다.
 *
 * 얼굴 사진인지 전신 사진인지는 §8.1의 적합성 기준을 그대로 쓴다 — 분류와 판정이 다른 잣대를 쓰면
 * "분류는 FRONT인데 FRONT 기준에 미달"하는 사진이 생긴다.
 */
export function classifyCaptureSlot(
  m: SlotMeasurement,
  policy = ASSET_QUALITY_POLICY,
  classifier = SLOT_CLASSIFIER_POLICY,
): SlotGuess {
  const detail: SlotGuess['detail'] = {
    faceHeightRatio: round(m.faceHeightRatio),
    bodyInFrameRatio: round(m.bodyInFrameRatio),
    signedNoseOffset: round(m.signedNoseOffset),
    eyeDistanceRatio: round(m.eyeDistanceRatio),
    minFaceHeightRatio: policy.minFaceHeightRatio,
    minBodyInFrameRatio: policy.minBodyInFrame,
    frontMaxOffset: classifier.frontMaxOffset,
    profileMinOffset: classifier.profileMinOffset,
  };

  const bodyOk = (m.bodyInFrameRatio ?? 0) >= policy.minBodyInFrame;

  if (!m.hasFace) {
    // 얼굴이 없는데 전신이 다 들어왔으면 뒷모습으로 본다. 그 외에는 판단 근거가 없다.
    return bodyOk
      ? { slot: 'BODY_BACK', assetType: 'BODY_IMAGE', needsReview: true,
          reason: '얼굴이 보이지 않고 전신이 들어와 뒷모습으로 분류했습니다 — 확인이 필요합니다', detail }
      : { slot: null, assetType: null, needsReview: true,
          reason: '얼굴을 찾지 못했고 전신도 아니어서 분류할 수 없습니다', detail };
  }

  const faceRatio = m.faceHeightRatio ?? 0;
  const offset = m.signedNoseOffset;
  if (offset === null || !Number.isFinite(offset)) {
    return { slot: null, assetType: null, needsReview: true,
      reason: '얼굴 랜드마크를 얻지 못해 각도를 판단할 수 없습니다', detail };
  }

  const { yaw, needsReview } = classifyYaw(offset, m.eyeDistanceRatio, classifier);
  detail.yaw = yaw;

  // 얼굴이 화면에서 충분히 크면 얼굴 슬롯, 전신이 들어와 있으면 전신 슬롯이다.
  if (faceRatio >= policy.minFaceHeightRatio) {
    return { slot: yaw, assetType: 'FACE_IMAGE', needsReview,
      reason: `얼굴이 화면의 ${Math.round(faceRatio * 100)}%이고 ${yawLabel(yaw)}으로 보입니다`, detail };
  }
  if (bodyOk) {
    const bodySlot = yaw === 'FRONT' ? 'BODY_FRONT' : yaw.startsWith('LEFT') ? 'BODY_LEFT' : 'BODY_RIGHT';
    return { slot: bodySlot, assetType: 'BODY_IMAGE', needsReview,
      reason: `전신이 들어왔고 ${yawLabel(yaw)}으로 보입니다`, detail };
  }

  // 얼굴 슬롯에는 작고 전신 슬롯에는 잘렸다 — 반신 사진이 여기 온다
  return { slot: null, assetType: null, needsReview: true,
    reason: `얼굴은 화면의 ${Math.round(faceRatio * 100)}%로 작고 전신도 다 들어오지 않아(${Math.round((m.bodyInFrameRatio ?? 0) * 100)}%) 분류할 수 없습니다`,
    detail };
}

function yawLabel(yaw: Yaw): string {
  switch (yaw) {
    case 'FRONT': return '정면';
    case 'LEFT_45': return '좌측 45도';
    case 'RIGHT_45': return '우측 45도';
    case 'LEFT_90': return '좌측 측면';
    case 'RIGHT_90': return '우측 측면';
  }
}

/** 5점 랜드마크(좌눈·우눈·코·좌입·우입)에서 분류용 신호를 뽑는다 */
export function slotSignalsFromLandmarks(
  landmarks: Array<[number, number]> | number[][] | null | undefined,
  bboxWidth: number | null | undefined,
): { signedNoseOffset: number | null; eyeDistanceRatio: number | null } {
  if (!landmarks || landmarks.length < 3) return { signedNoseOffset: null, eyeDistanceRatio: null };
  const [le, re, nose] = landmarks as number[][];
  const eyeMidX = (le[0] + re[0]) / 2;
  const eyeDist = Math.hypot(re[0] - le[0], re[1] - le[1]);
  if (eyeDist <= 0) return { signedNoseOffset: null, eyeDistanceRatio: null };
  return {
    signedNoseOffset: (nose[0] - eyeMidX) / eyeDist,
    eyeDistanceRatio: bboxWidth && bboxWidth > 0 ? eyeDist / bboxWidth : null,
  };
}
