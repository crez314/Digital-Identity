import type { GenerationRequest, ImagePlan, PlannedImage } from './types';

/** 같은 위치 안에서는 의상 → 헤어, 위치가 정해진 첨부 → 전원 공통 → 배경 순으로 자리를 준다 */
const KIND_ORDER: Record<string, number> = { OUTFIT: 0, HAIR: 1, BACKGROUND: 2 };

/**
 * 모르는 종류는 맨 뒤로 보낸다.
 *
 * 직접 인덱싱하면 새 종류가 생겼을 때 undefined가 나오고 뺄셈이 NaN이 되어 비교자가 망가진다.
 * 그러면 정렬이 실패를 알리지 않은 채 **모든 첨부의 순서**가 엉킨다.
 * (START_FRAME은 첨부가 아니라 워커가 시작 프레임으로 치환하므로 여기까지 오지 않는다.)
 */
const kindOrder = (kind: string): number => KIND_ORDER[kind] ?? Number.MAX_SAFE_INTEGER;

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
      // 워커가 대표로 지정한 사진이 먼저다 — 품질 순으로만 세우면 모든 구간이
      // 같은 사진(= image-to-video에서는 같은 시작 프레임)으로 수렴한다(§5.1)
      .sort((a, b) => Number(b.lead ?? false) - Number(a.lead ?? false) || (b.quality ?? 0) - (a.quality ?? 0))
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
      kindOrder(x.a.kind) - kindOrder(y.a.kind)
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
