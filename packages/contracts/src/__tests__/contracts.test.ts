import { describe, expect, it } from 'vitest';
import { RightsCheckRequest, SetCastRequest } from '../index';
import { QcScoreResponse, VideoAnalyzeResponse } from '../ml';

describe('contracts', () => {
  it('rights check request는 ISO 3166-1 alpha-2만 허용한다', () => {
    expect(RightsCheckRequest.safeParse({ identityIds: [crypto.randomUUID()], usageType: 'MV', territory: 'KR' }).success).toBe(true);
    expect(RightsCheckRequest.safeParse({ identityIds: [crypto.randomUUID()], usageType: 'MV', territory: 'kor' }).success).toBe(false);
  });

  it('캐스트는 최대 10인', () => {
    const member = (i: number) => ({ identityId: crypto.randomUUID(), slotIndex: i, appearance: {} });
    const cast = Array.from({ length: 11 }, (_, i) => member(i));
    expect(SetCastRequest.safeParse({ cast, usageType: 'MV' }).success).toBe(false);
  });

  it('ML 응답은 modelBundle을 반드시 포함한다 (§7 재현성)', () => {
    const withoutBundle = { videoKey: 'k', durationMs: 1000, perIdentity: [] };
    expect(QcScoreResponse.safeParse(withoutBundle).success).toBe(false);
    const analyze = { videoKey: 'k', durationMs: 1, fps: 30, width: 1, height: 1, tracks: [] };
    expect(VideoAnalyzeResponse.safeParse(analyze).success).toBe(false);
  });
});
