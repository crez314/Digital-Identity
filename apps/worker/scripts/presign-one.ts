/** 실험용 — 자산 하나의 공개 접근 URL을 만든다. 운영 경로가 아니다. */
import { presignedGet } from '../src/lib/media-io';

const key = process.argv[2];
presignedGet(key, 7200).then((u) => { console.log(u); process.exit(0); });
