import { describe, expect, it } from 'vitest';
import { CrezError, ErrorCode, ERROR_MESSAGES } from '../error-codes';
import { MAX_REGEN, QUEUE_POLICY, hasPermission, storageKey } from '../constants';

describe('에러 규약 (§17)', () => {
  it('모든 코드가 CREZ-{DOMAIN}-{NNN} 형식이다', () => {
    // 명세 §17의 QC 도메인은 두 글자다 (CREZ-QC-001).
    for (const code of Object.values(ErrorCode)) {
      expect(code).toMatch(/^CREZ-[A-Z]{2,3}-\d{3}$/);
    }
  });

  it('모든 코드에 메시지가 정의되어 있다', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_MESSAGES[code]).toBeTruthy();
    }
  });

  it('응답 본문은 { code, message, detail, traceId }로 통일된다', () => {
    const body = new CrezError(ErrorCode.QC_BELOW_THRESHOLD, undefined, { score: 0.8 }).toBody('t-1');
    expect(Object.keys(body).sort()).toEqual(['code', 'detail', 'message', 'traceId']);
    expect(body.code).toBe('CREZ-QC-001');
    expect(body.traceId).toBe('t-1');
  });

  it('§8 제공자 오류는 재시도 대상, 콘텐츠 정책 거부는 아니다', () => {
    expect(new CrezError(ErrorCode.GEN_PROVIDER_ERROR).retryable).toBe(true);
    expect(new CrezError(ErrorCode.GEN_CONTENT_POLICY).retryable).toBe(false);
    expect(new CrezError(ErrorCode.RGT_CONSENT_INVALID).retryable).toBe(false);
  });
});

describe('스토리지 레이아웃 (§15)', () => {
  it('세그먼트 결과물은 attempt별로 분리된다', () => {
    expect(storageKey.segmentOutput('p1', 's1', 2)).toBe('projects/p1/segments/s1/attempt-2/output.mp4');
    expect(storageKey.segmentOutput('p1', 's1', 1)).not.toBe(storageKey.segmentOutput('p1', 's1', 2));
  });

  it('QC 근거 프레임은 attempt 아래에 시각별로 놓인다', () => {
    expect(storageKey.qcFrame('p1', 's1', 3, 1500)).toBe('projects/p1/segments/s1/attempt-3/qc/frames/1500.jpg');
  });

  it('마스터와 프로파일은 버전 경로를 갖는다', () => {
    expect(storageKey.master('p1', 2)).toBe('projects/p1/masters/2/master.mp4');
    expect(storageKey.profileManifest('i1', 3)).toBe('identities/i1/profiles/3/manifest.json');
  });
});

describe('큐 정책 (§8)', () => {
  it('재생성 큐는 재시도하지 않는다 — 전략 자체가 재시도다', () => {
    expect(QUEUE_POLICY.regeneration.attempts).toBe(1);
  });

  it('GPU 바운드 분석 큐의 동시성이 가장 낮다', () => {
    expect(QUEUE_POLICY.analysis.concurrency).toBeLessThan(QUEUE_POLICY.ingest.concurrency);
  });

  it('재생성 한도는 3이다 (§5.1)', () => {
    expect(MAX_REGEN).toBe(3);
  });
});

describe('권한 (§16)', () => {
  it('OWNER만 조직을 관리한다', () => {
    expect(hasPermission('OWNER', 'ORG_MANAGE')).toBe(true);
    expect(hasPermission('ADMIN', 'ORG_MANAGE')).toBe(false);
  });
});
