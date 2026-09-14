import type { GenerationRequest, ImagePlan, PlannedImage } from './types';

/** 같은 위치 안에서는 의상 → 헤어, 위치가 정해진 첨부 → 전원 공통 → 배경 순으로 자리를 준다 */
const KIND_ORDER = { OUTFIT: 0, HAIR: 1, BACKGROUND: 2 } as const;

/**
 * 제공자가 받는 이미지 수(max) 안에서 인물 신원 레퍼런스와 프롬프트 참고 이미지를 배분한다.
 *
 *   1) 위치 순으로 인물마다 대표 얼굴 1장 — 신원 일관성이 CREZ의 핵심이라 첨부에 밀리지 않는다
 *   2) 참고 이미지 — 위치별 의상·헤어, 전원 공통, 배경 순
 *   3) 남은 자리는 인물별 추가 얼굴을 라운드로빈으로 채운다 (첨부가 없으면 기존 동작과 같다)
 *
 * 한도 때문에 빠진 참고 이미지는 droppedReferenceIds로 돌려준다 — 조용히 사라지면
 * "첨부했는데 반영이 안 됐다"를 설명할 방법이 없다.
 */
export function planImages(req: GenerationRequest, max: number): ImagePlan {
  const cast = [...req.cast].sort((a, b) => a.slotIndex - b.slotIndex);
  const faces = cast.map((c) =>
    c.references
      .filter((r) => r.signedUrl)
      .sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0))
      .map<PlannedImage>((r) => ({
        role: 'IDENTITY', url: r.signedUrl as string, slotIndex: c.slotIndex, identityId: r.identityId, assetId: r.assetId,
      })),
  );

  const images: PlannedImage[] = [];
  const room = () => images.length < max;

  for (const list of faces) if (list[0] && room()) images.push(list[0]);

  const attachments = req.attachments
    .filter((a) => a.signedUrl)
    .map((a, order) => ({ a, order }))
    .sort((x, y) =>
      KIND_ORDER[x.a.kind] - KIND_ORDER[y.a.kind]
      || (x.a.slotIndex ?? Number.MAX_SAFE_INTEGER) - (y.a.slotIndex ?? Number.MAX_SAFE_INTEGER)
      || x.order - y.order,
    )
    .map(({ a }) => a);

  const droppedReferenceIds: string[] = [];
  for (const a of attachments) {
    if (room()) {
      images.push({ role: a.kind, url: a.signedUrl as string, slotIndex: a.slotIndex, referenceId: a.referenceId });
    } else {
      droppedReferenceIds.push(a.referenceId);
    }
  }
  // URL을 만들지 못한 첨부도 전달되지 않았다
  for (const a of req.attachments) if (!a.signedUrl) droppedReferenceIds.push(a.referenceId);

  for (let round = 1; room(); round++) {
    let added = false;
    for (const list of faces) {
      if (list[round] && room()) {
        images.push(list[round]);
        added = true;
      }
    }
    if (!added) break;
  }

  return { images, droppedReferenceIds };
}
