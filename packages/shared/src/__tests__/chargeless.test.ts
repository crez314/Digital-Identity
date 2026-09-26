import { describe, expect, it } from 'vitest';
import { CrezError, ErrorCode, isChargelessFailure } from '../index';

/**
 * 실패한 생성을 실지출에서 뺄지 판단하는 규칙 (§12.1).
 * 과소 집계는 한도를 무력화하므로, "돈이 나가지 않았다"가 확실할 때만 뺀다.
 */
describe('과금 없는 실패 판정', () => {
  it('제공자가 거절한 응답은 과금되지 않는다', () => {
    expect(isChargelessFailure(new CrezError(ErrorCode.GEN_CONTENT_POLICY, 'nsfw'))).toBe(true);
    expect(isChargelessFailure(new CrezError(ErrorCode.GEN_QUOTA_EXCEEDED, '크레딧 부족'))).toBe(true);
    expect(isChargelessFailure(new CrezError(ErrorCode.GEN_NO_CAPABLE_MODEL, 'model_blocked'))).toBe(true);
  });

  it('요청이 네트워크에 나가지도 못했으면 과금되지 않는다', () => {
    const err = new CrezError(ErrorCode.GEN_PROVIDER_ERROR, '키 미설정', { sent: false }, 500);
    expect(isChargelessFailure(err)).toBe(true);
  });

  it('제공자가 접수하지 않았다고 표시된 오류도 과금되지 않는다', () => {
    const err = new CrezError(ErrorCode.GEN_PROVIDER_ERROR, 'higgsfield 400', { sent: true, accepted: false }, 502);
    expect(isChargelessFailure(err)).toBe(true);
  });

  it('접수 여부를 모르는 실패는 과금된 것으로 본다 — 전송 중 끊김·응답 파싱 실패', () => {
    expect(isChargelessFailure(new CrezError(ErrorCode.GEN_PROVIDER_ERROR, 'higgsfield 전송 오류'))).toBe(false);
    expect(isChargelessFailure(new CrezError(ErrorCode.GEN_PROVIDER_ERROR, '응답에 request_id 없음', { status: 200 })))
      .toBe(false);
  });

  it('CrezError가 아닌 오류는 판단하지 않는다 — 모르면 과금된 것으로 둔다', () => {
    expect(isChargelessFailure(new Error('boom'))).toBe(false);
    expect(isChargelessFailure(null)).toBe(false);
  });
});
