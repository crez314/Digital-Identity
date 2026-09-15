import type { Ml } from '@crez/contracts';

/**
 * 스토리지에 남기는 소스 트랙 시계열 (§4.2 timeline_key).
 *
 * 프레임별 얼굴·신체 벡터는 생체 템플릿이므로 스토리지에 평문으로 남기지 않는다(§16).
 * QC는 이 파일에서 bbox 궤적만 읽고(motion consistency), 벡터가 필요한 자동 매핑은 분석 직후 메모리에서 끝난다.
 * ML 응답에 계약 밖 필드가 섞여 와도 새지 않도록 남길 필드를 하나씩 고른다.
 */
export function toStoredTracks(tracks: Ml.PersonTrack[]) {
  return tracks.map((t) => ({
    trackIndex: t.trackIndex,
    startMs: t.startMs,
    endMs: t.endMs,
    frames: t.frames.map((f) => ({
      ms: f.ms,
      bbox: f.bbox,
      keypoints: f.keypoints ?? null,
      faceQuality: f.faceQuality,
      occlusion: f.occlusion ?? null,
    })),
  }));
}
