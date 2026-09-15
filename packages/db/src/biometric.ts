import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 얼굴·신체 임베딩(생체인식정보)의 애플리케이션 레벨 암호화 (§16, §22).
 *
 * 임베딩은 원본 사진 없이도 같은 사람을 식별할 수 있는 생체 템플릿이다. DB가 유출되거나 백업이
 * 새어 나가도 벡터를 쓸 수 없도록 AES-256-GCM으로 암호화해 bytea로 저장한다.
 * 유사도 계산은 원래부터 앱·ML 서비스에서 하므로(DB 벡터 검색 미사용) 기능 손실이 없다.
 *
 * - 키는 실명 컬럼(FIELD_ENCRYPTION_KEY)과 분리한다. 생체정보만 따로 폐기(키 파기)할 수 있어야 한다.
 * - 암호문을 어느 테이블·컬럼·행에 쓰는지를 AAD로 묶는다. 다른 인물의 행으로 옮겨 붙이면 복호화가 실패한다.
 *
 * 저장 형식: [버전 1B][IV 12B][GCM 태그 16B][float32 LE 벡터]
 */
const ALGO = 'aes-256-gcm';
const FORMAT_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH;

export const BIOMETRIC_KEY_ENV = 'BIOMETRIC_ENCRYPTION_KEY';

/** 암호문이 저장되는 위치. AAD에 들어가므로 값을 바꾸면 기존 암호문을 읽을 수 없다 */
export type BiometricSlot =
  | 'identity_embedding.vector'
  | 'identity_profile.face_centroid'
  | 'identity_profile.body_centroid'
  | 'source_track.face_centroid';

/** 저장소에 커밋된 예시 키 — 운영에서 쓰면 사실상 평문과 같다 */
const DEV_EXAMPLE_KEYS = new Set([
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
]);

function readKey(envName: string): Buffer {
  const hex = process.env[envName];
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${envName} must be 32-byte hex (64 chars)`);
  }
  return Buffer.from(hex, 'hex');
}

function biometricKey(): Buffer {
  return readKey(BIOMETRIC_KEY_ENV);
}

/**
 * 기동 시점에 암호화 키 설정을 검사한다. 요청을 받은 뒤에야 키 누락을 알면
 * 업로드된 사진의 임베딩 저장이 실패한 채로 남는다.
 */
export function assertEncryptionConfig(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of ['FIELD_ENCRYPTION_KEY', BIOMETRIC_KEY_ENV]) {
    const value = env[name];
    if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
      throw new Error(`${name} must be 32-byte hex (64 chars)`);
    }
    if (env.NODE_ENV === 'production' && DEV_EXAMPLE_KEYS.has(value.toLowerCase())) {
      throw new Error(`${name}에 저장소의 예시 키가 설정되어 있습니다 — 운영 환경에서는 새 키를 발급하세요`);
    }
  }
  if (env.FIELD_ENCRYPTION_KEY!.toLowerCase() === env[BIOMETRIC_KEY_ENV]!.toLowerCase()) {
    throw new Error(`${BIOMETRIC_KEY_ENV}는 FIELD_ENCRYPTION_KEY와 달라야 합니다 — 생체정보만 따로 폐기할 수 있어야 합니다`);
  }
}

function aad(slot: BiometricSlot, rowId: string): Buffer {
  return Buffer.from(`crez-biometric:v${FORMAT_VERSION}:${slot}:${rowId}`, 'utf8');
}

export function encryptVector(vector: number[], slot: BiometricSlot, rowId: string): Buffer {
  const plain = Buffer.alloc(vector.length * 4);
  vector.forEach((n, i) => plain.writeFloatLE(Number.isFinite(n) ? n : 0, i * 4));

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, biometricKey(), iv);
  cipher.setAAD(aad(slot, rowId));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decryptVector(stored: Uint8Array, slot: BiometricSlot, rowId: string): number[] {
  const buf = Buffer.from(stored);
  if (buf.length < HEADER_LENGTH || buf[0] !== FORMAT_VERSION || (buf.length - HEADER_LENGTH) % 4 !== 0) {
    throw new Error(`${slot}(${rowId}) 생체 벡터 암호문 형식이 올바르지 않습니다`);
  }
  const iv = buf.subarray(1, 1 + IV_LENGTH);
  const tag = buf.subarray(1 + IV_LENGTH, HEADER_LENGTH);
  const decipher = createDecipheriv(ALGO, biometricKey(), iv);
  decipher.setAAD(aad(slot, rowId));
  decipher.setAuthTag(tag);
  // 키가 다르거나 다른 행의 암호문을 옮겨 붙였으면 여기서 인증 실패로 예외가 난다
  const plain = Buffer.concat([decipher.update(buf.subarray(HEADER_LENGTH)), decipher.final()]);

  const out = new Array<number>(plain.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = plain.readFloatLE(i * 4);
  return out;
}
