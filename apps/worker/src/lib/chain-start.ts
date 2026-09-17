import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CHAIN_LENGTH, childLogger, storageKey } from '@crez/shared';
import { FFMPEG, run } from './ffmpeg';
import { downloadTo, presignedGet, uploadFrom } from './media-io';

/**
 * 컷 없이 이어지는 장면 만들기 (§5.1).
 *
 * 생성 모델은 한 번에 5~10초까지만 만든다. 한 컷을 그보다 길게 가려면 앞 구간의 마지막
 * 프레임을 다음 구간의 시작 프레임으로 넘겨 이어 붙이는 수밖에 없다.
 *
 * 다만 생성물을 다시 입력으로 쓰는 일이 반복되면 색이 바래고 디테일이 뭉개지며 인물이
 * 조금씩 흘러간다. 그래서 사슬 길이를 MAX_CHAIN_LENGTH에서 끊고 원본 레퍼런스로 돌아간다.
 *
 * K-pop 뮤직비디오는 2~4초마다 컷이 바뀌므로 대부분의 구간은 이 경로를 쓰지 않는다 —
 * 컷이 바뀌는 편이 자연스럽고, 세대 손실도 없다.
 */

/**
 * 이 구간에서 실제로 이어 붙일지 판단한다.
 * chainFlags[i]는 구간 i의 chainFromPrevious 값이다(구간 번호 순서).
 *
 * 첫 구간은 앞이 없어 이어 붙일 수 없고, 연속 사슬이 한도를 넘으면 끊는다.
 */
export function shouldChain(
  chainFlags: boolean[],
  index: number,
  maxChainLength: number = MAX_CHAIN_LENGTH,
): boolean {
  if (index <= 0 || index >= chainFlags.length) return false;
  if (!chainFlags[index]) return false;

  let length = 1;
  for (let i = index - 1; i > 0 && chainFlags[i]; i--) length += 1;
  return length <= maxChainLength;
}

/**
 * 앞 구간 결과물의 마지막 프레임을 뽑아 저장하고 presigned URL을 돌려준다.
 * 뽑지 못하면 null — 호출부는 원본 인물 레퍼런스로 되돌아간다. 이어 붙이기는 품질 선택이지
 * 생성 자체의 전제가 아니므로, 여기서 실패한다고 생성을 막지는 않는다.
 */
export async function buildChainStartFrame(opts: {
  previousOutputKey: string;
  projectId: string;
  segmentId: string;
  attempt: number;
  traceId: string;
}): Promise<{ url: string; storageKey: string } | null> {
  const log = childLogger({ traceId: opts.traceId, segmentId: opts.segmentId });
  const work = await mkdtemp(join(tmpdir(), 'crez-chain-'));
  try {
    const src = join(work, 'prev.mp4');
    const frame = join(work, 'tail.jpg');
    await downloadTo(opts.previousOutputKey, src);
    // -sseof는 끝에서부터의 오프셋이다. 마지막 0.2초 구간에서 첫 프레임을 뽑는다 —
    // 정확히 마지막 프레임을 노리면 컨테이너에 따라 빈 출력이 나온다.
    await run(FFMPEG, ['-y', '-sseof', '-0.2', '-i', src, '-frames:v', '1', '-q:v', '2', frame]);

    const key = storageKey.segmentChainStart(opts.projectId, opts.segmentId, opts.attempt);
    await uploadFrom(key, frame, 'image/jpeg');
    const url = await presignedGet(key);
    if (!url) return null;
    return { url, storageKey: key };
  } catch (e) {
    log.warn({ err: String(e), previousOutputKey: opts.previousOutputKey },
      '앞 구간 마지막 프레임을 뽑지 못했다 — 인물 레퍼런스로 시작한다');
    return null;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
