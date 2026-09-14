/** 업로드 확정 요청에 넣는 파일 체크섬 (SHA-256 hex) */
export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * presigned URL 발급 → 스토리지 직접 업로드 → 확정 (§15).
 * 발급 응답에서 id와 URL을 꺼내는 방식만 호출하는 쪽마다 다르다.
 */
export async function uploadViaPresignedUrl(opts: {
  file: File;
  contentType: string;
  requestUrl: () => Promise<{ id: string; uploadUrl: string }>;
  confirm: (id: string, checksum: string) => Promise<unknown>;
}): Promise<void> {
  const { id, uploadUrl } = await opts.requestUrl();
  const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': opts.contentType }, body: opts.file });
  if (!res.ok) throw new Error(`${opts.file.name} 스토리지 업로드 실패 (HTTP ${res.status})`);
  await opts.confirm(id, await sha256Hex(opts.file));
}
