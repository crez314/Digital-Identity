import { logger } from '@crez/shared';
import type { GenerationProvider, GenerationRequest } from '@crez/providers';
import { ensureReferenceDerivative } from './reference-image';
import { readObject } from './media-io';

/**
 * 레퍼런스 사진을 제공자 스토리지로 올려 두고, 요청에는 그 주소를 쓴다.
 *
 * 그동안은 우리 MinIO를 인터넷에 열어(cloudflared 임시 터널) presigned URL을 넘겼다. 그 터널이
 * 끊기면 제공자가 사진을 못 받아 생성이 통째로 실패했고, 실제로 하루에 두 번 끊겨 시도를 날렸다
 * (2026-09-25 CREZ-GEN-002 "Please provide a publicly accessible HTTP or HTTPS URL").
 * 제공자가 입력 파일을 직접 받아 주면(uploadAsset) 공개 주소가 아예 필요 없다.
 *
 * 올리는 것은 원본이 아니라 축소본이다(reference-image.ts). 같은 사진을 매번 다시 올리지 않도록
 * 결과 주소를 캐시하되, 제공자가 임시 보관(retention=temporary)이라고 표시하므로 오래 믿지 않는다.
 */
const CACHE_TTL_MS = Number(process.env.PROVIDER_ASSET_TTL_MS ?? 20 * 60 * 1000);
const cache = new Map<string, { url: string; at: number }>();

/** 테스트에서 상태를 지운다 */
export function clearProviderAssetCache() {
  cache.clear();
}

async function uploadOne(provider: GenerationProvider, storageKey: string, now: number): Promise<string | null> {
  const hit = cache.get(storageKey);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.url;
  try {
    const key = await ensureReferenceDerivative(storageKey);
    const body = await readObject(key);
    const url = await provider.uploadAsset!(body, key.endsWith('.png') ? 'image/png' : 'image/jpeg');
    cache.set(storageKey, { url, at: now });
    return url;
  } catch (e) {
    // 올리지 못하면 기존 공개 주소를 그대로 쓴다 — 공개 주소가 살아 있으면 생성은 계속된다.
    logger.warn({ storageKey, err: String(e) }, '제공자 스토리지 업로드 실패 — 기존 주소를 그대로 쓴다');
    return null;
  }
}

/**
 * 요청 안의 레퍼런스 주소를 제공자 스토리지 주소로 바꾼다.
 * 제공자가 업로드를 지원하지 않으면 아무것도 하지 않는다.
 */
export async function hostReferencesOnProvider(
  req: GenerationRequest, provider: GenerationProvider, now = Date.now(),
): Promise<{ uploaded: number; kept: number }> {
  if (typeof provider.uploadAsset !== 'function') return { uploaded: 0, kept: 0 };
  let uploaded = 0;
  let kept = 0;
  for (const member of req.cast) {
    for (const ref of member.references) {
      if (!ref.storageKey) { kept += 1; continue; }
      const url = await uploadOne(provider, ref.storageKey, now);
      if (url) {
        ref.signedUrl = url;
        uploaded += 1;
      } else {
        kept += 1;
      }
    }
  }
  for (const attachment of req.attachments) {
    if (!attachment.storageKey) { kept += 1; continue; }
    const url = await uploadOne(provider, attachment.storageKey, now);
    if (url) {
      attachment.signedUrl = url;
      uploaded += 1;
    } else {
      kept += 1;
    }
  }
  return { uploaded, kept };
}
