/** 도메인 상수 (기술명세서 §5, §8, §9, §10, §15) */

/** 세그먼트 생성 최대 시도 (§5.1) */
export const MAX_GENERATION_ATTEMPT = 3;
/** 재생성 전략 사다리 최대 단계 (§5.1, §11) */
export const MAX_REGEN = 3;
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
