const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * Higgsfield 경로별 허용 생성 길이(초).
 *
 * 제출(providers의 Higgsfield 어댑터)과 비용 견적(ai_model.capabilities.durations)이 이 표 하나를 쓴다.
 * 둘이 따로 적혀 있으면 한쪽만 고쳐지기 쉽고, 그러면 견적과 실제 과금 길이가 어긋나 지출 한도가 틀린 값으로 막는다.
 *
 * 출처: 각 모드의 input_schema — https://open.higgsfield.ai/models/<경로>/api-reference (2026-09-22 조회).
 * 범위형(minimum~maximum)은 정수 전부를 나열한다. 스냅은 가장 가까운 값으로 한다(snapDuration).
 */
export const HIGGSFIELD_DURATIONS: Readonly<Record<string, readonly number[]>> = {
  '/veo3.1/reference-to-video': [4, 6, 8],
  '/veo3.1/image-to-video': [4, 6, 8],
  '/veo3.1/fast/image-to-video': [4, 6, 8],
  '/sora-2/image-to-video': [4, 8, 12],

  '/kling-video/v2.1/standard/image-to-video': [5, 10],
  '/kling-video/v2.1/pro/image-to-video': [5, 10],
  '/kling-video/v2.1/master/image-to-video': [5, 10],
  '/kling-video/v2.5-turbo/pro/image-to-video': [5, 10],
  '/kling-video/v2.5-turbo/standard/image-to-video': [5, 10],
  '/kling-video/v2.6/pro/image-to-video': [5, 10],
  '/kling-video/v3.0/std/image-to-video': range(3, 15),
  '/kling-video/v3.0/pro/image-to-video': range(3, 15),
  '/kling-video/v3.0/4k/image-to-video': range(3, 15),
  '/kling-video/v3.0-turbo/image-to-video': range(3, 15),
  '/kling-video/o3/image-reference': range(3, 15),
  '/kling-video/omni/image-reference': range(3, 10),

  '/bytedance/seedance-2.5/image-to-video': range(4, 30),
  '/bytedance/seedance-2.5/reference-to-video': range(4, 30),
  '/bytedance/seedance-2.0/image-to-video': range(4, 15),
  '/bytedance/seedance-2.0/reference-to-video': range(4, 15),

  '/minimax/h3/image-to-video': range(5, 15),
  '/minimax/h3/reference-to-video': range(5, 15),
  '/minimax/hailuo-2.3/standard/image-to-video': [6, 10],
};
