import { describe, expect, it } from 'vitest';
import { EMBEDDING_STORAGE_DIM, cosineSimilarity, toStorageVector } from '@crez/db';
import { BODY_EMBEDDING_DIM } from '@crez/shared';

describe('임베딩 저장 차원 (§4.2)', () => {
  it('신체 임베딩(256차원)은 vector(512)에 맞게 뒤를 0으로 채운다', () => {
    const body = Array.from({ length: BODY_EMBEDDING_DIM }, (_, i) => Math.sin(i + 1));
    const stored = toStorageVector(body);

    expect(stored).toHaveLength(EMBEDDING_STORAGE_DIM);
    expect(stored.slice(0, BODY_EMBEDDING_DIM)).toEqual(body);
    expect(stored.slice(BODY_EMBEDDING_DIM).every((x) => x === 0)).toBe(true);
  });

  it('패딩해도 코사인 유사도는 그대로다', () => {
    const a = Array.from({ length: BODY_EMBEDDING_DIM }, (_, i) => Math.sin(i + 1));
    const b = Array.from({ length: BODY_EMBEDDING_DIM }, (_, i) => Math.cos(i * 0.5));
    expect(cosineSimilarity(toStorageVector(a), toStorageVector(b))).toBeCloseTo(cosineSimilarity(a, b), 10);
  });

  it('이미 512차원이면 그대로 두고, 넘으면 거절한다', () => {
    const face = new Array<number>(EMBEDDING_STORAGE_DIM).fill(0.1);
    expect(toStorageVector(face)).toBe(face);
    expect(() => toStorageVector(new Array<number>(EMBEDDING_STORAGE_DIM + 1).fill(0))).toThrow();
  });
});
