/**
 * 신원 유지 프롬프트 (§10, §11).
 *
 * image-to-video 계열은 시작 이미지 1장에서 영상을 이어 붙인다. 프롬프트가 시작 이미지와
 * 다른 장소·다른 인물을 요구하면 모델은 그 충돌을 "장면 전환"으로 푼다 — 컷이 바뀌면서
 * 주 피사체가 다른 사람으로 교체되고, QC는 IDENTITY_DRIFT로 떨어진다.
 * 실측: kling v2.5 turbo pro, 사무실 전신 사진 + "무대에서 멤버들과 춤추는" 프롬프트,
 * cfg_scale 0.6 → 1.25초 이후 장면 전환, 3.75초에 인물 완전 교체, 종합 점수 0.373.
 *
 * 그래서 제공자에 보내는 프롬프트에는 항상 "레퍼런스 인물이 끝까지 주 피사체이고 컷이 없다"는
 * 제약을 붙이고, 지원하는 제공자에는 부정 프롬프트도 함께 보낸다.
 */

/**
 * 프롬프트 뒤에 붙이는 신원 고정 문구.
 * 한국어 프롬프트에도 영어 제약이 더 잘 먹어서 영어로 쓴다(제공자 모델 대부분이 영어 기준으로 학습).
 * 인원 수는 제한하지 않는다 — "멤버들과 함께" 같은 요구를 막는 대신, 레퍼런스 인물이
 * 주 피사체 자리를 지키도록만 강제한다.
 */
export const IDENTITY_ANCHOR =
  'The person in the reference image stays the main subject for the entire clip: '
  + 'same face, same hairstyle, same outfit, no replacement by another person. '
  + 'One continuous shot from the reference image — no cut, no scene change, camera stays on this person.';

/** 부정 프롬프트 — negative_prompt를 받는 제공자에만 보낸다 */
export const IDENTITY_NEGATIVE_PROMPT =
  'different person, face swap, identity change, morphing face, deformed face, '
  + 'cut, jump cut, scene change, new location, subject replaced, '
  + 'different hairstyle, different clothes';

/**
 * 운영자 프롬프트에 신원 고정 문구를 덧붙인다.
 * 원문은 그대로 두고 뒤에 붙이기만 한다 — 운영자가 쓴 문장을 고쳐 쓰면 결과를 설명할 수 없다.
 * 이미 붙어 있으면 다시 붙이지 않는다(재생성 경로에서 프롬프트를 복원해 다시 보낼 때).
 */
export function withIdentityAnchor(prompt: string | null): string {
  const base = (prompt ?? '').trim();
  if (base.includes(IDENTITY_ANCHOR)) return base;
  return base ? `${base}\n\n${IDENTITY_ANCHOR}` : IDENTITY_ANCHOR;
}

/**
 * 콘텐츠 정책(nsfw) 거부 뒤 자동 재제출에 덧붙이는 안전 문구.
 *
 * Higgsfield의 nsfw 판정은 **결과물**을 보고 내린다 — 같은 프롬프트·같은 레퍼런스로 보낸 요청이
 * 성공하기도 하고 거부되기도 한다(2026-09-25 seedance 2.5 실측: 접수 12건 중 3건 nsfw).
 * 그래서 재시도는 씨앗만 바꾸지 않고, 판정을 넘길 여지를 남기도록 의상·동작을 보수적으로 못 박는다.
 * 운영자 문장은 고치지 않고 뒤에 붙이기만 한다 — 결과를 설명할 수 있어야 한다.
 */
export const SAFE_CONTENT_CLAUSE =
  'Content must stay safe for all audiences: everyone fully clothed in modest everyday wardrobe, '
  + 'neutral non-suggestive posture and framing, no nudity, no lingerie or swimwear, '
  + 'no intimate contact, no violence.';

/** 정책 거부 재시도용 프롬프트. 이미 붙어 있으면 다시 붙이지 않는다. */
export function withSafeContent(prompt: string): string {
  const base = (prompt ?? '').trim();
  if (base.includes(SAFE_CONTENT_CLAUSE)) return base;
  return base ? `${base}\n\n${SAFE_CONTENT_CLAUSE}` : SAFE_CONTENT_CLAUSE;
}

/**
 * cfg_scale(kling 등) ← conditioningStrength 변환.
 *
 * 이 시스템의 conditioningStrength는 "신원 조건화 강도"다 — 높을수록 레퍼런스 인물에 붙어야 한다.
 * 반면 kling의 cfg_scale은 스펙상 "프롬프트 준수 강도"로, 높을수록 텍스트를 따라가며
 * 시작 이미지에서 멀어진다. 그대로 넘기면 재생성 1단계(CONDITIONING_BOOST)가
 * conditioningStrength를 올릴 때마다 오히려 인물 이탈이 심해진다 — 뒤집어서 넘긴다.
 */
export function promptAdherenceFromConditioning(conditioningStrength: number): number {
  const s = Number.isFinite(conditioningStrength) ? conditioningStrength : 0.6;
  const clamped = Math.min(1, Math.max(0, s));
  return Number((1 - clamped).toFixed(2));
}
