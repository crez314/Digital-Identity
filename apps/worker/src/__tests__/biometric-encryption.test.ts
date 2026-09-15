import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertEncryptionConfig, decryptVector, encryptVector } from '@crez/db';

const FIELD_KEY = randomBytes(32).toString('hex');
const vector = Array.from({ length: 512 }, (_, i) => Math.sin(i + 1) * 0.1);

function float32Bytes(v: number[]): Buffer {
  const buf = Buffer.alloc(v.length * 4);
  v.forEach((n, i) => buf.writeFloatLE(n, i * 4));
  return buf;
}

describe('생체 벡터 암호화 (§16)', () => {
  const saved = process.env.BIOMETRIC_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.BIOMETRIC_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BIOMETRIC_ENCRYPTION_KEY;
    else process.env.BIOMETRIC_ENCRYPTION_KEY = saved;
  });

  it('pgvector와 같은 float32 정밀도로 그대로 복원한다', () => {
    const enc = encryptVector(vector, 'identity_embedding.vector', 'row-a');
    expect(decryptVector(enc, 'identity_embedding.vector', 'row-a')).toEqual(vector.map(Math.fround));
  });

  it('암호문에 평문 벡터 바이트가 들어 있지 않고, 같은 벡터도 매번 다르게 암호화된다', () => {
    const a = encryptVector(vector, 'identity_embedding.vector', 'row-a');
    const b = encryptVector(vector, 'identity_embedding.vector', 'row-a');
    expect(a.includes(float32Bytes(vector).subarray(0, 32))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it('다른 인물의 행이나 다른 컬럼으로 옮겨 붙인 암호문은 복호화되지 않는다', () => {
    const enc = encryptVector(vector, 'identity_profile.face_centroid', 'profile-a');
    expect(() => decryptVector(enc, 'identity_profile.face_centroid', 'profile-b')).toThrow();
    expect(() => decryptVector(enc, 'identity_profile.body_centroid', 'profile-a')).toThrow();
  });

  it('키가 다르거나 암호문이 1바이트라도 바뀌면 복호화되지 않는다', () => {
    const enc = encryptVector(vector, 'source_track.face_centroid', 'track-a');
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => decryptVector(tampered, 'source_track.face_centroid', 'track-a')).toThrow();

    process.env.BIOMETRIC_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    expect(() => decryptVector(enc, 'source_track.face_centroid', 'track-a')).toThrow();
  });

  it('기동 검사: 키 누락·형식 오류·실명 키와 같은 키·운영에서의 예시 키를 거부한다', () => {
    const biometric = randomBytes(32).toString('hex');
    const devBiometric = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

    expect(() => assertEncryptionConfig({ FIELD_ENCRYPTION_KEY: FIELD_KEY, BIOMETRIC_ENCRYPTION_KEY: biometric })).not.toThrow();
    expect(() => assertEncryptionConfig({ FIELD_ENCRYPTION_KEY: FIELD_KEY })).toThrow(/BIOMETRIC_ENCRYPTION_KEY/);
    expect(() => assertEncryptionConfig({ FIELD_ENCRYPTION_KEY: FIELD_KEY, BIOMETRIC_ENCRYPTION_KEY: 'abc' })).toThrow(/64 chars/);
    expect(() => assertEncryptionConfig({ FIELD_ENCRYPTION_KEY: FIELD_KEY, BIOMETRIC_ENCRYPTION_KEY: FIELD_KEY })).toThrow(/달라야/);
    // 개발 환경에서는 저장소 예시 키를 허용하지만 운영에서는 거부한다
    expect(() => assertEncryptionConfig({ FIELD_ENCRYPTION_KEY: FIELD_KEY, BIOMETRIC_ENCRYPTION_KEY: devBiometric })).not.toThrow();
    expect(() => assertEncryptionConfig({
      NODE_ENV: 'production', FIELD_ENCRYPTION_KEY: FIELD_KEY, BIOMETRIC_ENCRYPTION_KEY: devBiometric,
    })).toThrow(/예시 키/);
  });
});
