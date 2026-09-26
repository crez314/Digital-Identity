import { describe, expect, it } from 'vitest';
import { toStoredTracks } from '../lib/source-tracks';

describe('소스 트랙 파일 (§4.2, §16)', () => {
  it('스토리지에 남기는 트랙에는 얼굴·신체 벡터가 없고 QC가 쓰는 궤적은 그대로 남는다', () => {
    const bbox = { x: 10, y: 20, w: 30, h: 40 };
    const frame = {
      ms: 200, bbox, keypoints: null, faceQuality: 0.9, occlusion: 0.1,
      faceVector: [0.12, 0.34],
      // 계약 밖 필드가 ML 응답에 섞여 와도 남기지 않는다
      bodyVector: [0.56],
    };
    const stored = toStoredTracks([{
      trackIndex: 0, startMs: 0, endMs: 400, faceCentroid: [0.12], bodyCentroid: [0.56],
      quality: 0.8, frameCount: 1, frames: [frame],
    }]);

    expect(stored).toEqual([{
      trackIndex: 0, startMs: 0, endMs: 400,
      frames: [{ ms: 200, bbox, keypoints: null, faceQuality: 0.9, occlusion: 0.1 }],
    }]);
    expect(JSON.stringify(stored)).not.toMatch(/Vector|Centroid/);
  });
});
