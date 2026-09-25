/**
 * Higgsfield 실제 모델 등록 목록 (ai_model).
 *
 * 전체 시드는 지출 정책·룰셋·샘플 인물까지 덮어쓰므로, 모델만 바꿀 때는 sync-models.ts로 이 목록만 반영한다.
 *
 *   pnpm --filter @crez/db sync:models
 *
 * 상태: 2026-09-22 계정 조회 결과를 따른다. 본문 없이 제출해 400(형식 오류)이 오면 권한이 열린 것,
 * 404 model_not_found·423 model_blocked·503 model_disabled면 막힌 것이다. **열림은 권한 검사 통과일 뿐
 * 생성 성공을 뜻하지 않는다** — 실제 생성까지 확인된 모델은 kling 2.5 turbo pro i2v뿐이다.
 *
 * 단가(costPerSecond): Higgsfield API는 달러로 과금한다. 카탈로그(open.higgsfield.ai)의 **할인 전 정가**를
 * 초당 USD로 넣었다. 지출 한도가 할인 종료 뒤에도 과소 견적하지 않게 하려는 것이다. 해상도·길이·오디오에 따라
 * 실제 단가가 다르므로 모드 설명에서 3초 이상 클립 기준의 높은 쪽을 골랐다. 원화 환산은 지출 정책의
 * creditUnitPriceKrw(= 1 USD의 원화 값)로 한다.
 *
 * 허용 길이는 @crez/shared의 HIGGSFIELD_DURATIONS를 그대로 쓴다 — 제출과 견적이 같은 표를 봐야 한다.
 */
import type { PrismaClient } from '@prisma/client';
import { HIGGSFIELD_DURATIONS } from '@crez/shared';

interface HiggsfieldModel {
  code: string;
  endpoint: string;
  /** CREZ 생성 모드. reference = 인물 레퍼런스 여러 장으로 신원을 조건화 */
  mode: 'i2v' | 'reference';
  /**
   * 한 구간에 세울 수 있는 인물 수. 라우터가 캐스트 수와 비교해 모델을 거른다.
   *
   * 제공자가 공개하는 값이 아니다 — ByteDance·Higgsfield 문서 어디에도 인물 수 상한은 없고
   * 레퍼런스 장수 상한(이미지 30장 + 영상 10 + 오디오 10)만 있다. 그래서 장수로 감당되는 범위에서
   * 실제로 써 본 만큼만 올린다. 2026-09-25 현재 레퍼런스 4명까지 열어 두었고, 인물이 늘수록
   * 얼굴이 섞일 수 있으므로 QC 점수로 확인한 뒤 더 올린다.
   * i2v는 시작 이미지가 한 장이라 구조상 1명이다.
   */
  maxPersons: number;
  maxResolution: number;
  costPerSecond: number;
  pricingSource: string;
  active: boolean;
}

const CATALOG = 'Higgsfield 카탈로그 정가(할인 전) USD/초, 2026-09-22 조회';
const UNKNOWN = '미확정 — 계정에서 막혀 카탈로그에 없음';

export const HIGGSFIELD_MODELS: readonly HiggsfieldModel[] = [
  // ── 막힘 (2026-09-22) ──
  { code: 'higgsfield-veo31-reference', endpoint: '/veo3.1/reference-to-video', mode: 'reference', maxPersons: 3, maxResolution: 1080, costPerSecond: 0.4, pricingSource: UNKNOWN, active: false },
  { code: 'higgsfield-veo31-i2v', endpoint: '/veo3.1/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 1080, costPerSecond: 0.3, pricingSource: UNKNOWN, active: false },
  { code: 'higgsfield-sora2-i2v', endpoint: '/sora-2/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 720, costPerSecond: 0.35, pricingSource: UNKNOWN, active: false },
  // 423 model_blocked. 2026-09-16엔 202로 받아 놓고 4초 만에 실패했다
  { code: 'higgsfield-kling21-pro-i2v', endpoint: '/kling-video/v2.1/pro/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 1080, costPerSecond: 0.2, pricingSource: UNKNOWN, active: false },
  { code: 'higgsfield-kling21-standard-i2v', endpoint: '/kling-video/v2.1/standard/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 1080, costPerSecond: 0.12, pricingSource: UNKNOWN, active: false },
  { code: 'higgsfield-kling21-master-i2v', endpoint: '/kling-video/v2.1/master/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 1080, costPerSecond: 0.3, pricingSource: UNKNOWN, active: false },

  // ── 열림: 시작 이미지 1장 (i2v) — 인물 1명 ──
  { code: 'higgsfield-kling25-pro-i2v', endpoint: '/kling-video/v2.5-turbo/pro/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 1080, costPerSecond: 0.07, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-kling25-standard-i2v', endpoint: '/kling-video/v2.5-turbo/standard/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 720, costPerSecond: 0.042, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-kling26-pro-i2v', endpoint: '/kling-video/v2.6/pro/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 1080, costPerSecond: 0.14, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-kling30-std-i2v', endpoint: '/kling-video/v3.0/std/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 720, costPerSecond: 0.126, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-kling30-pro-i2v', endpoint: '/kling-video/v3.0/pro/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 1080, costPerSecond: 0.168, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-kling30-4k-i2v', endpoint: '/kling-video/v3.0/4k/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 2160, costPerSecond: 0.42, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-kling30-turbo-i2v', endpoint: '/kling-video/v3.0-turbo/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 1080, costPerSecond: 0.14, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-seedance25-i2v', endpoint: '/bytedance/seedance-2.5/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 720, costPerSecond: 0.2057, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-seedance20-i2v', endpoint: '/bytedance/seedance-2.0/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 2160, costPerSecond: 0.1407, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-minimax-h3-i2v', endpoint: '/minimax/h3/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 1440, costPerSecond: 0.13, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-hailuo23-i2v', endpoint: '/minimax/hailuo-2.3/standard/image-to-video', mode: 'i2v', maxPersons: 1, maxResolution: 720, costPerSecond: 0.056, pricingSource: CATALOG, active: true },

  // ── 열림: 인물 레퍼런스 여러 장 (reference) — Identity conditioning 경로 ──
  { code: 'higgsfield-seedance25-reference', endpoint: '/bytedance/seedance-2.5/reference-to-video', mode: 'reference', maxPersons: 4, maxResolution: 720, costPerSecond: 0.2057, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-seedance20-reference', endpoint: '/bytedance/seedance-2.0/reference-to-video', mode: 'reference', maxPersons: 4, maxResolution: 2160, costPerSecond: 0.1407, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-minimax-h3-reference', endpoint: '/minimax/h3/reference-to-video', mode: 'reference', maxPersons: 4, maxResolution: 1440, costPerSecond: 0.13, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-kling-o3-reference', endpoint: '/kling-video/o3/image-reference', mode: 'reference', maxPersons: 3, maxResolution: 720, costPerSecond: 0.084, pricingSource: CATALOG, active: true },
  { code: 'higgsfield-kling-omni-reference', endpoint: '/kling-video/omni/image-reference', mode: 'reference', maxPersons: 3, maxResolution: 1080, costPerSecond: 0.112, pricingSource: CATALOG, active: true },
];

export async function syncHiggsfieldModels(prisma: PrismaClient): Promise<{ active: number; disabled: number }> {
  let active = 0;
  for (const m of HIGGSFIELD_MODELS) {
    const durations = HIGGSFIELD_DURATIONS[m.endpoint];
    if (!durations) throw new Error(`${m.code}: ${m.endpoint}의 허용 길이가 HIGGSFIELD_DURATIONS에 없다`);
    const capabilities = {
      modes: [m.mode], maxPersons: m.maxPersons, maxResolution: m.maxResolution,
      maxDurationMs: Math.max(...durations) * 1000, durations: [...durations],
      billable: true, endpoint: m.endpoint, pricingSource: m.pricingSource,
    };
    const status = m.active ? 'ACTIVE' : 'DISABLED';
    if (m.active) active += 1;
    await prisma.aiModel.upsert({
      where: { code: m.code },
      update: { capabilities, endpoint: m.endpoint, costPerSecond: m.costPerSecond, status },
      create: {
        code: m.code, provider: 'EXTERNAL_API', endpoint: m.endpoint, capabilities,
        costPerSecond: m.costPerSecond, status, metrics: {},
      },
    });
  }
  return { active, disabled: HIGGSFIELD_MODELS.length - active };
}
