import { describe, expect, it } from 'vitest';
import {
  CHAIN_ASSET_PREFIX, isChainAsset, isSyntheticAsset, PINNED_ASSET_PREFIX, shouldChain,
} from '../lib/chain-start';

/**
 * 컷 없이 이어지는 장면은 앞 구간의 마지막 프레임에서 출발한다.
 * 다만 생성물을 다시 입력으로 쓰는 일이 반복되면 색이 바래고 인물이 흘러가므로(세대 손실)
 * 사슬은 한도에서 끊고 원본 레퍼런스로 돌아간다(§5.1).
 */
describe('이어 붙이기 사슬', () => {
  it('첫 구간은 앞이 없어 이어 붙일 수 없다', () => {
    expect(shouldChain([true, true, true], 0)).toBe(false);
  });

  it('이어 붙이기를 끈 구간은 그대로 인물 레퍼런스에서 출발한다', () => {
    expect(shouldChain([false, false, false], 1)).toBe(false);
  });

  it('한도(3)까지는 이어 붙인다', () => {
    const flags = [false, true, true, true, true];
    expect(shouldChain(flags, 1)).toBe(true);   // 사슬 길이 1
    expect(shouldChain(flags, 2)).toBe(true);   // 2
    expect(shouldChain(flags, 3)).toBe(true);   // 3
  });

  it('한도를 넘으면 끊고 원본 레퍼런스로 돌아간다', () => {
    const flags = [false, true, true, true, true];
    expect(shouldChain(flags, 4)).toBe(false);  // 사슬 길이 4 — 세대 손실이 쌓인다
  });

  it('중간에 끊긴 뒤 다시 시작하면 사슬 길이도 다시 센다', () => {
    //            0      1     2     3      4     5
    const flags = [false, true, true, false, true, true];
    expect(shouldChain(flags, 4)).toBe(true);
    expect(shouldChain(flags, 5)).toBe(true);
  });

  it('한도는 호출부가 정할 수 있다', () => {
    const flags = [false, true, true];
    expect(shouldChain(flags, 2, 1)).toBe(false);
    expect(shouldChain(flags, 2, 2)).toBe(true);
  });

  it('범위 밖 구간 번호는 이어 붙이지 않는다', () => {
    expect(shouldChain([false, true], 5)).toBe(false);
    expect(shouldChain([], 0)).toBe(false);
  });
});

describe('이어 붙인 시작 프레임의 id', () => {
  it('실제 자산 id와 구분된다', () => {
    // 2026-09-17: 이 가짜 id가 자산 조회에 섞여 들어가 결과 조회가 통째로 실패했다.
    // identity_asset에 없는 값이라 UUID 파싱 단계에서 터진다.
    expect(isChainAsset(`${CHAIN_ASSET_PREFIX}370c922b-f5fc-44cb-b38c-668a684f9e03`)).toBe(true);
    expect(isChainAsset('370c922b-f5fc-44cb-b38c-668a684f9e03')).toBe(false);
  });
});

/**
 * 가짜 assetId 걸러 내기.
 *
 * 이어 붙인 프레임과 사람이 지정한 프레임은 identity_asset 행이 아니다. 이 id가 자산 조회에
 * 섞이면 UUID 컬럼 파싱에서 조회가 통째로 터지는데, 그 조회는 생성이 **성공한 뒤** 결과를
 * 거둬들이는 경로에 있다 — 돈은 이미 나갔는데 결과물만 잃는다(2026-09-17 실측).
 */
describe('identity_asset이 아닌 가짜 id', () => {
  it('이어 붙인 프레임을 걸러 낸다', () => {
    expect(isSyntheticAsset(`${CHAIN_ASSET_PREFIX}seg-1`)).toBe(true);
  });

  it('사람이 지정한 시작 프레임도 걸러 낸다', () => {
    expect(isSyntheticAsset(`${PINNED_ASSET_PREFIX}ref-1`)).toBe(true);
  });

  it('진짜 자산 UUID는 통과시킨다', () => {
    expect(isSyntheticAsset('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(false);
  });

  it('두 접두사는 서로 겹치지 않는다 — 지정 프레임을 이어 붙이기로 오인하면 이력이 틀어진다', () => {
    expect(isChainAsset(`${PINNED_ASSET_PREFIX}ref-1`)).toBe(false);
  });
});
