import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@crez/shared';
import type { FetchResult } from '@crez/providers';
import { encodeWithFallback, probe } from './ffmpeg';
import { uploadFrom } from './media-io';
import { storage } from './storage';

/**
 * 생성 결과를 오브젝트 스토리지의 정해진 키에 실체화한다.
 *
 * 어댑터는 "결과가 어디 있는지"만 알려준다(§12 어댑터 계약). 외부 제공자는 임시 URL을
 * 주고, mock 어댑터는 실제 파일을 만들지 않는다. 스토리지 레이아웃(§15)을 지키는 책임은
 * 워커에 둔다 — 그래야 어댑터가 S3 자격증명을 알 필요가 없다.
 */
export async function materializeOutput(
  result: FetchResult,
  outputKey: string,
  opts: { isMock: boolean; traceId: string },
): Promise<FetchResult> {
  // 이미 지정된 키에 실체가 있으면 그대로 쓴다
  if (result.storageKey === outputKey && (await storage.exists(outputKey))) {
    return result;
  }

  // 외부 제공자가 URL을 준 경우 — 내려받아 우리 버킷으로 옮긴다
  if (/^https?:\/\//.test(result.storageKey)) {
    const work = await mkdtemp(join(tmpdir(), 'crez-fetch-'));
    try {
      const local = join(work, 'output.mp4');
      const res = await fetch(result.storageKey);
      if (!res.ok) throw new Error(`결과물 다운로드 실패 ${res.status}`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(local, Buffer.from(await res.arrayBuffer()));
      await uploadFrom(outputKey, local, 'video/mp4');
      const meta = await probe(local);
      return { ...result, storageKey: outputKey, ...meta };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  if (!opts.isMock) {
    // 자체 호스팅 모델이 직접 버킷에 쓰기로 되어 있는데 객체가 없다면 오류다.
    throw new Error(`생성 결과물을 찾을 수 없습니다: ${result.storageKey}`);
  }

  // mock — §18 GPU·외부 계약 없이 전체 플로우(생성→QC→마스터→파생물)를 돌리기 위해
  // 재생 가능한 더미 클립을 만든다. 색상 바에 타임코드를 얹어 세그먼트 경계를 눈으로 구분한다.
  const work = await mkdtemp(join(tmpdir(), 'crez-mock-'));
  try {
    const local = join(work, 'output.mp4');
    const seconds = Math.max(result.durationMs / 1000, 0.5);
    await encodeWithFallback((enc) => [
      '-y',
      '-f', 'lavfi', '-i', `testsrc=size=${result.width}x${result.height}:rate=${result.fps}:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-c:v', enc, '-b:v', '2M', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
      local,
    ]);
    await uploadFrom(outputKey, local, 'video/mp4');
    logger.debug({ outputKey, traceId: opts.traceId }, 'mock output materialized');
    return { ...result, storageKey: outputKey };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
