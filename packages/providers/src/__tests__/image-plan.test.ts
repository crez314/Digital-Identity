import { describe, expect, it } from 'vitest';
import { planImages } from '../image-plan';
import type { GenerationRequest, PromptAttachment } from '../types';

const person = (id: string, slotIndex: number, faces: number, leadIndex = -1) => ({
  identityId: id, profileId: `p-${id}`, slotIndex, appearance: {},
  references: Array.from({ length: faces }, (_, i) => ({
    identityId: id, assetId: `${id}${i + 1}`, storageKey: 'k', signedUrl: `https://s3/${id}${i + 1}.jpg`,
    captureSlot: null, expression: null, quality: 1 - i * 0.1, lead: i === leadIndex,
  })),
});
const ref = (referenceId: string, kind: PromptAttachment['kind'], slotIndex: number | null, signed = true): PromptAttachment => ({
  referenceId, kind, slotIndex, storageKey: `refs/${referenceId}`, signedUrl: signed ? `https://s3/${referenceId}.jpg` : null,
});
const request = (cast: GenerationRequest['cast'], attachments: PromptAttachment[] = []) =>
  ({ cast, attachments } as unknown as GenerationRequest);
const urls = (r: ReturnType<typeof planImages>) => r.images.map((i) => i.url.replace('https://s3/', '').replace('.jpg', ''));

describe('제공자 이미지 배분', () => {
  it('첨부가 없으면 인물별 얼굴을 라운드로빈으로 채운다 (기존 동작)', () => {
    expect(urls(planImages(request([person('A', 0, 3), person('B', 1, 3)]), 3))).toEqual(['A1', 'B1', 'A2']);
  });

  it('위치 순서대로 인물을 넣는다 — 캐스트 배열 순서와 무관하다', () => {
    expect(urls(planImages(request([person('B', 1, 1), person('A', 0, 1)]), 3))).toEqual(['A1', 'B1']);
  });

  it('인물마다 얼굴 1장을 먼저 보장하고, 첨부는 위치별 의상·헤어 → 전원 공통 → 배경 순이다', () => {
    const plan = planImages(
      request([person('A', 0, 3), person('B', 1, 3)], [
        ref('bg', 'BACKGROUND', null), ref('hairB', 'HAIR', 1), ref('outAll', 'OUTFIT', null), ref('outA', 'OUTFIT', 0),
      ]),
      Number.POSITIVE_INFINITY,
    );
    expect(urls(plan)).toEqual(['A1', 'B1', 'outA', 'outAll', 'hairB', 'bg', 'A2', 'B2', 'A3', 'B3']);
    expect(plan.images.find((i) => i.referenceId === 'outA')).toMatchObject({ role: 'OUTFIT', slotIndex: 0 });
  });

  it('한도를 넘는 첨부는 빠진 목록으로 돌려주고, 첨부가 추가 얼굴보다 우선한다', () => {
    const plan = planImages(request([person('A', 0, 3), person('B', 1, 3)], [ref('out', 'OUTFIT', 0), ref('bg', 'BACKGROUND', null)]), 3);
    expect(urls(plan)).toEqual(['A1', 'B1', 'out']);
    expect(plan.droppedReferenceIds).toEqual(['bg']);
  });

  it('인물이 한도만큼 많으면 첨부는 모두 빠진다 — 신원 조건화가 먼저다', () => {
    const plan = planImages(request([person('A', 0, 1), person('B', 1, 1), person('C', 2, 1)], [ref('bg', 'BACKGROUND', null)]), 3);
    expect(urls(plan)).toEqual(['A1', 'B1', 'C1']);
    expect(plan.droppedReferenceIds).toEqual(['bg']);
  });

  it('URL을 만들지 못한 첨부도 전달되지 않은 것으로 기록한다', () => {
    const plan = planImages(request([person('A', 0, 1)], [ref('broken', 'HAIR', 0, false)]), 3);
    expect(urls(plan)).toEqual(['A1']);
    expect(plan.droppedReferenceIds).toEqual(['broken']);
  });
});

describe('구간별 대표 이미지', () => {
  it('워커가 지정한 대표가 품질 1위를 제치고 시작 프레임이 된다', () => {
    // image-to-video는 첫 이미지가 곧 시작 프레임이다. 대표를 돌리지 못하면
    // 1분 영상의 컷 12개가 전부 같은 사진에서 출발한다.
    const r = planImages(request([person('a', 0, 4, 2)]), 1);
    expect(urls(r)).toEqual(['a3']);
  });

  it('대표 지정이 없으면 기존대로 품질 순이다', () => {
    const r = planImages(request([person('a', 0, 4)]), 1);
    expect(urls(r)).toEqual(['a1']);
  });

  it('대표를 세워도 나머지 사진은 품질 순으로 뒤를 채운다', () => {
    const r = planImages(request([person('a', 0, 4, 3)]), 3);
    expect(urls(r)).toEqual(['a4', 'a1', 'a2']);
  });
});
