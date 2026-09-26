import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@crez/shared';
import { FFMPEG, run } from './ffmpeg';
import { downloadTo, objectExists, presignedGet, uploadFrom } from './media-io';

/**
 * 외부 제공자에게 넘길 레퍼런스 사진의 축소본.
 *
 * 제공자는 presigned URL을 **자기 서버에서 직접 내려받는다**. 원본은 장당 1.5~1.8MB(896×1200 PNG)라
 * 4명 × 7~8장이면 한 요청에 45MB가 걸리고, 그 다운로드가 길어지면 제출이 500으로 튕기거나
 * 접수된 뒤 "Generation failed"로 끝났다 — 2026-09-25 seedance 2.5 실측(3번 중 2번 실패).
 *
 * 장수를 줄이면 실패는 없어지지만 신원 유사도가 떨어져 보였다(29장 0.614 vs 8장 0.512 — 다만 장면이 달라
 * 통제된 비교는 아니다). 그래서 장수를 줄이는 대신 **장당 용량**을 줄인다.
 *
 * 해상도는 과하게 줄이면 안 된다. 긴 변 768px·q4로 줄여 30장을 보냈더니 같은 장면에서 얼굴 유사도가
 * 0.63~0.73 → 0.47~0.56으로 떨어졌다(2026-09-25 실측). 지금은 긴 변 1280px·q2로 둔다 — 원본 대비
 * 용량은 크게 줄면서 얼굴 화소는 충분히 남는다.
 *
 * 한 번 만든 축소본은 스토리지에 남겨 다음 생성에서 다시 만들지 않는다.
 */
const MAX_EDGE = Number(process.env.REFERENCE_IMAGE_MAX_EDGE ?? 1280);
/** ffmpeg -q:v (2=최고화질, 31=최저). 신원 판정에 쓰이는 사진이라 압축은 최소로 한다 */
const JPEG_QUALITY = process.env.REFERENCE_IMAGE_QUALITY ?? '2';

export function derivedKey(storageKey: string, maxEdge = MAX_EDGE): string {
  const dir = storageKey.slice(0, storageKey.lastIndexOf('/'));
  return `${dir}/ref-${maxEdge}.jpg`;
}

/** 축소본 키를 보장한다. 실패하면 원본 키를 그대로 돌려준다 — 생성 자체를 막지는 않는다. */
export async function ensureReferenceDerivative(storageKey: string): Promise<string> {
  const target = derivedKey(storageKey);
  if (target === storageKey) return storageKey;
  try {
    if (await objectExists(target)) return target;
    const dir = await mkdtemp(join(tmpdir(), 'crez-ref-'));
    try {
      const src = join(dir, 'src');
      const out = join(dir, 'ref.jpg');
      await downloadTo(storageKey, src);
      // 원본보다 키우지 않는다(min) — 작은 사진을 늘려 봐야 정보가 늘지 않는다
      await run(FFMPEG, [
        '-v', 'error', '-y', '-i', src,
        '-vf', `scale=w='min(${MAX_EDGE},iw)':h='min(${MAX_EDGE},ih)':force_original_aspect_ratio=decrease`,
        '-q:v', JPEG_QUALITY, out,
      ], 120000);
      await uploadFrom(target, out, 'image/jpeg');
      return target;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (e) {
    logger.warn({ storageKey, err: String(e) }, '레퍼런스 축소본을 만들지 못해 원본을 그대로 보낸다');
    return storageKey;
  }
}

/** 축소본을 보장하고 그 presigned URL을 만든다 */
export async function presignReference(storageKey: string, ttl?: number): Promise<string> {
  return presignedGet(await ensureReferenceDerivative(storageKey), ttl);
}
