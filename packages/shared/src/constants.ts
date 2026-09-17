/** 도메인 상수 (기술명세서 §5, §8, §9, §10, §15) */

/** 세그먼트 생성 최대 시도 (§5.1) */
export const MAX_GENERATION_ATTEMPT = 3;
/** 재생성 전략 사다리 최대 단계 (§5.1, §11) */
export const MAX_REGEN = 3;
/**
 * 과금 제공자(ai_model.capabilities.billable)의 QC 실패 시 자동 재생성 한도 (§11).
 * 기본 0 — 자동 재생성은 곧 자동 과금이고, 제출한 요청은 제공자가 취소를 거부할 수 있어 되돌릴 수 없다(§12.1).
 * 운영자가 QC 결과를 보고 수동 재생성(POST /segments/{id}/regenerate)으로만 다시 돌린다.
 * PAID_AUTO_REGEN_LIMIT 환경변수로 올릴 수 있다.
 */
export const PAID_AUTO_REGEN_LIMIT = 0;
/**
 * 앞 구간의 마지막 프레임을 다음 구간의 시작 프레임으로 넘기는 사슬의 최대 길이 (§5.1).
 *
 * 컷 없이 이어지는 장면을 만들려면 이어 붙여야 하지만, 생성물의 마지막 프레임을 다시 입력으로
 * 쓰는 일이 반복되면 색이 바래고 디테일이 뭉개지며 인물이 조금씩 흘러간다(세대 손실).
 * 이 값에 도달하면 사슬을 끊고 원본 인물 레퍼런스에서 다시 출발한다.
 */
export const MAX_CHAIN_LENGTH = 3;

/** 연속 NO_CHANGE 횟수가 이 값이면 즉시 MANUAL_REVIEW 승격 (§5.1) */
export const NO_CHANGE_ESCALATION_LIMIT = 2;

/** 자동 매핑 임계값 (§9.1) — 운영 중 ruleset으로 이관 가능 */
export const TAU_ASSIGN = 0.35;
export const DELTA_MARGIN = 0.06;
/** track centroid 산출에 사용할 상위 품질 프레임 수 (§9.1) */
export const TRACK_CENTROID_TOP_K = 20;

/** presigned URL 만료 (§15) */
export const PRESIGN_TTL_SECONDS = 900;

/** 큐 이름 (§8) */
export const QUEUE = {
  INGEST: 'ingest',
  ANALYSIS: 'analysis',
  GENERATION: 'generation',
  QC: 'qc',
  REGENERATION: 'regeneration',
  MEDIA: 'media',
} as const;
export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** 큐별 동시성·재시도 정책 (§8) */
export const QUEUE_POLICY: Record<QueueName, { concurrency: number; attempts: number; backoffMs: number }> = {
  ingest: { concurrency: 4, attempts: 3, backoffMs: 2000 },
  analysis: { concurrency: 2, attempts: 2, backoffMs: 5000 },
  generation: { concurrency: 8, attempts: 3, backoffMs: 10000 },
  qc: { concurrency: 4, attempts: 2, backoffMs: 3000 },
  regeneration: { concurrency: 2, attempts: 1, backoffMs: 0 },
  media: { concurrency: 4, attempts: 3, backoffMs: 5000 },
};

/** 프로파일 빌드 필수 캡처 슬롯 (§4.2 capture_slot, §17 CREZ-IDN-001) */
export const REQUIRED_FACE_SLOTS = ['FRONT', 'LEFT_45', 'RIGHT_45', 'LEFT_90', 'RIGHT_90'] as const;
export const REQUIRED_BODY_SLOTS = ['BODY_FRONT'] as const;

/**
 * 자산 품질검사 판정 기준 (§17 CREZ-IDN-002). 워커가 판정하고, api는 재검사 대상을 고를 때 쓴다.
 * 판정 당시 값은 identity_asset.quality_detail에 함께 남는다.
 */
export const ASSET_QUALITY_POLICY = {
  /** 품질 점수 하한 */
  minQuality: 0.4,
  /**
   * 얼굴 슬롯: 얼굴 높이가 화면 세로의 이 비율보다 작으면 전신·반신 사진으로 본다.
   * 실측(2026-09-11, 휴대폰 세로 사진, 긴 변 640px 검출) — 얼굴 사진 34~53%, 전신 사진 9.7~11.5%.
   */
  minFaceHeightRatio: 0.15,
  /**
   * 신체 슬롯: 얼굴 기준으로 추정한 전신 높이 중 이 비율 이상이 화면에 있어야 전신 사진으로 본다.
   * 실측 — 전신 사진 1.00, 얼굴 사진 0.26~0.41.
   */
  minBodyInFrame: 0.85,
} as const;

/** 임베딩 차원 (§4.2) */
export const FACE_EMBEDDING_DIM = 512;
export const BODY_EMBEDDING_DIM = 256;

/** 스토리지 레이아웃 (§15) */
export const storageKey = {
  identityAsset: (identityId: string, assetId: string, ext: string) =>
    `identities/${identityId}/assets/${assetId}/original.${ext}`,
  identityAssetThumb: (identityId: string, assetId: string) =>
    `identities/${identityId}/assets/${assetId}/thumb.jpg`,
  profileManifest: (identityId: string, version: number) =>
    `identities/${identityId}/profiles/${version}/manifest.json`,
  sourceVideo: (projectId: string, sourceVideoId: string) =>
    `projects/${projectId}/source/${sourceVideoId}/original.mp4`,
  sourceTracks: (projectId: string, sourceVideoId: string) =>
    `projects/${projectId}/source/${sourceVideoId}/tracks.parquet`,
  segmentOutput: (projectId: string, segmentId: string, attempt: number) =>
    `projects/${projectId}/segments/${segmentId}/attempt-${attempt}/output.mp4`,
  /** 앞 구간에서 뽑아 이 구간의 시작 프레임으로 넘기는 이미지 */
  segmentChainStart: (projectId: string, segmentId: string, attempt: number) =>
    `projects/${projectId}/segments/${segmentId}/attempt-${attempt}/chain-start.jpg`,
  segmentReference: (projectId: string, segmentId: string, referenceId: string, ext: string) =>
    `projects/${projectId}/segments/${segmentId}/references/${referenceId}.${ext}`,
  qcFrame: (projectId: string, segmentId: string, attempt: number, ms: number) =>
    `projects/${projectId}/segments/${segmentId}/attempt-${attempt}/qc/frames/${ms}.jpg`,
  master: (projectId: string, version: number) => `projects/${projectId}/masters/${version}/master.mp4`,
  derivative: (projectId: string, derivativeId: string) =>
    `projects/${projectId}/derivatives/${derivativeId}/output.mp4`,
};

/** 역할별 권한 (§16) */
export const ROLES = ['OWNER', 'ADMIN', 'PRODUCER', 'OPERATOR', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  ORG_MANAGE: ['OWNER'],
  IDENTITY_WRITE: ['OWNER', 'ADMIN'],
  RIGHTS_WRITE: ['OWNER', 'ADMIN'],
  MODEL_MANAGE: ['OWNER', 'ADMIN'],
  PROJECT_CREATE: ['OWNER', 'ADMIN', 'PRODUCER'],
  PROJECT_RUN: ['OWNER', 'ADMIN', 'PRODUCER', 'OPERATOR'],
  MAPPING_WRITE: ['OWNER', 'ADMIN', 'PRODUCER', 'OPERATOR'],
  QC_ACCEPT: ['OWNER', 'ADMIN', 'PRODUCER'],
  READ: ['OWNER', 'ADMIN', 'PRODUCER', 'OPERATOR', 'VIEWER'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: string, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly string[]).includes(role);
}
