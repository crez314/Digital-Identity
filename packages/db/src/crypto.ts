import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * identity.legal_name 등 개인식별정보 컬럼의 애플리케이션 레벨 암호화 (§4.2).
 * 생체정보·실명은 개인정보보호법 검토 대상이므로 평문 저장하지 않는다 (§22 법적 검토).
 */
const ALGO = 'aes-256-gcm';

function key(): Buffer {
  const hex = process.env.FIELD_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('FIELD_ENCRYPTION_KEY must be 32-byte hex (64 chars)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptField(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptField(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const [v, ivB, tagB, dataB] = stored.split('.');
  if (v !== 'v1' || !ivB || !tagB || !dataB) return null;
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}
