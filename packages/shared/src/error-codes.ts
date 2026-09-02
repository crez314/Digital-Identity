/**
 * 에러 코드 규약 (기술명세서 §17)
 * 형식: CREZ-{DOMAIN}-{NNN}
 * 응답 본문: { code, message, detail, traceId }
 */
export const ErrorCode = {
  // Identity
  IDN_SLOT_INCOMPLETE: 'CREZ-IDN-001',
  IDN_ASSET_QUALITY: 'CREZ-IDN-002',
  IDN_EMBEDDING_VARIANCE: 'CREZ-IDN-003',
  IDN_NOT_FOUND: 'CREZ-IDN-004',
  IDN_PROFILE_NOT_ACTIVE: 'CREZ-IDN-005',
  // Rights
  RGT_CONSENT_INVALID: 'CREZ-RGT-001',
  RGT_USAGE_NOT_ALLOWED: 'CREZ-RGT-002',
  RGT_TERRITORY_NOT_ALLOWED: 'CREZ-RGT-003',
  // Mapping
  MAP_LOW_CONFIDENCE: 'CREZ-MAP-001',
  MAP_INCOMPLETE: 'CREZ-MAP-002',
  // Generation
  GEN_NO_CAPABLE_MODEL: 'CREZ-GEN-001',
  GEN_PROVIDER_ERROR: 'CREZ-GEN-002',
  GEN_CONTENT_POLICY: 'CREZ-GEN-003',
  GEN_QUOTA_EXCEEDED: 'CREZ-GEN-004',
  // QC
  QC_BELOW_THRESHOLD: 'CREZ-QC-001',
  QC_REGEN_LIMIT: 'CREZ-QC-002',
  QC_RULESET_NOT_FOUND: 'CREZ-QC-003',
  // Project / generic
  PRJ_INVALID_STATE: 'CREZ-PRJ-001',
  PRJ_NOT_FOUND: 'CREZ-PRJ-002',
  REQ_SCHEMA_INVALID: 'CREZ-REQ-001',
  AUTH_FORBIDDEN: 'CREZ-AUT-001',
  AUTH_UNAUTHENTICATED: 'CREZ-AUT-002',
  INTERNAL: 'CREZ-SYS-001',
  ML_UNAVAILABLE: 'CREZ-SYS-002',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_MESSAGES: Record<ErrorCodeValue, string> = {
  'CREZ-IDN-001': '필수 캡처 슬롯 미충족으로 프로파일 빌드 불가',
  'CREZ-IDN-002': '자산 품질 미달 (블러·해상도·얼굴 크기)',
  'CREZ-IDN-003': '임베딩 산포 과다 — 동일 인물이 아닌 자산 혼입 의심',
  'CREZ-IDN-004': 'Identity를 찾을 수 없음',
  'CREZ-IDN-005': '활성 프로파일이 없음',
  'CREZ-RGT-001': 'consent 미승인 또는 만료',
  'CREZ-RGT-002': '요청 용도가 허용 범위 밖',
  'CREZ-RGT-003': '요청 지역이 허용 범위 밖',
  'CREZ-MAP-001': '자동 매핑 신뢰도 미달 — 수동 확인 필요',
  'CREZ-MAP-002': '매핑되지 않은 트랙이 존재',
  'CREZ-GEN-001': '조건을 만족하는 생성 모델 없음',
  'CREZ-GEN-002': '제공자 API 오류 (재시도 대상)',
  'CREZ-GEN-003': '제공자 콘텐츠 정책 거부 (재시도 대상 아님)',
  'CREZ-GEN-004': '모델 quota 초과',
  'CREZ-QC-001': 'QC 임계값 미달',
  'CREZ-QC-002': '재생성 한도 초과',
  'CREZ-QC-003': 'ruleset을 찾을 수 없음',
  'CREZ-PRJ-001': '현재 상태에서 허용되지 않는 전이',
  'CREZ-PRJ-002': '프로젝트를 찾을 수 없음',
  'CREZ-REQ-001': '요청 본문이 스키마와 일치하지 않습니다',
  'CREZ-AUT-001': '권한 없음',
  'CREZ-AUT-002': '인증 필요',
  'CREZ-SYS-001': '내부 오류',
  'CREZ-SYS-002': 'ML 추론 서비스에 연결할 수 없음',
};

/** 재시도 가능한 에러인지 (§8 큐 재시도 정책) */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  ErrorCode.GEN_PROVIDER_ERROR,
  ErrorCode.ML_UNAVAILABLE,
]);

export class CrezError extends Error {
  constructor(
    readonly code: ErrorCodeValue,
    message?: string,
    readonly detail?: unknown,
    readonly httpStatus = 400,
  ) {
    super(message ?? ERROR_MESSAGES[code] ?? code);
    this.name = 'CrezError';
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  toBody(traceId?: string) {
    return { code: this.code, message: this.message, detail: this.detail ?? null, traceId: traceId ?? null };
  }
}
