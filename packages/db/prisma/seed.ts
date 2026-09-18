/**
 * 로컬 개발 시드 (§18): 샘플 identity 5명 + 더미 모델 어댑터.
 * 추가로 §10 점수 ruleset 초기값과 §12 라우팅 가중치를 넣는다.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { encryptField } from '../src/crypto';
import { setProfileCentroids } from '../src/vector';

const prisma = new PrismaClient();

/** 결정론적 더미 임베딩 — 시드마다 같은 값이 나와야 테스트가 재현된다. */
function pseudoVector(seed: string, dim: number): number[] {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < dim; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h |= 0;
    out.push((h % 1000) / 1000);
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

async function main() {
  const orgId = randomUUID();
  await prisma.organization.upsert({
    where: { id: orgId },
    update: {},
    create: { id: orgId, name: 'CREZ' },
  }).catch(() => undefined);

  const org = await prisma.organization.findFirst({ where: { name: 'CREZ' } })
    ?? await prisma.organization.create({ data: { name: 'CREZ' } });

  // ── 사용자 (§16 역할) ──────────────────────────────────
  const users = [
    { email: 'owner@hicrez.com', displayName: 'Owner', role: 'OWNER' },
    { email: 'admin@hicrez.com', displayName: 'Admin', role: 'ADMIN' },
    { email: 'producer@hicrez.com', displayName: 'Producer', role: 'PRODUCER' },
    { email: 'operator@hicrez.com', displayName: 'Operator', role: 'OPERATOR' },
    { email: 'viewer@hicrez.com', displayName: 'Viewer', role: 'VIEWER' },
  ];
  for (const u of users) {
    await prisma.appUser.upsert({
      where: { email: u.email },
      update: { role: u.role, orgId: org.id },
      create: { ...u, orgId: org.id },
    });
  }

  // ── 샘플 Identity 5명 + 프로파일 v1 ────────────────────
  const names = ['ARI', 'BOM', 'CHAE', 'DAON', 'EUN'];
  for (let i = 0; i < names.length; i++) {
    const code = `CRZ-A${String(i + 1).padStart(3, '0')}`;
    const identity = await prisma.identity.upsert({
      where: { orgId_code: { orgId: org.id, code } },
      update: {},
      create: {
        orgId: org.id,
        code,
        displayName: names[i],
        legalName: encryptField(`${names[i]} 실명`),
        status: 'ACTIVE',
      },
    });

    const existing = await prisma.identityProfile.findUnique({
      where: { identityId_version: { identityId: identity.id, version: 1 } },
    });
    if (existing) continue;

    const profile = await prisma.identityProfile.create({
      data: {
        identityId: identity.id,
        version: 1,
        status: 'ACTIVE',
        faceVariance: 0.012,
        attributes: {
          bodyRatios: { shoulderHipRatio: 1.28 + i * 0.01, legTorsoRatio: 1.12 + i * 0.01 },
          motionSignature: { cadence: 0.5 + i * 0.02 },
          seeded: true,
        },
        modelBundle: {
          detector: 'yunet@2023mar',
          faceEmbedder: 'sface@2021dec',
          bodyDetector: 'rtmdet-m@1.0',
          tracker: 'bytetrack@1.0',
          poseEstimator: 'rtmpose-m@1.0',
          runtime: 'seed',
        },
        builtAt: new Date(),
      },
    });

    const face = pseudoVector(`${code}-face`, 512);
    const body = pseudoVector(`${code}-body`, 256);
    await setProfileCentroids(profile.id, face, body);

    // 권리 정보 — 시드 인물은 MV/SHORTS 국내 상업 이용 허용 (§14.1)
    await prisma.identityRights.create({
      data: {
        identityId: identity.id,
        ownerName: `${names[i]} 소속사`,
        consentStatus: 'GRANTED',
        allowedUsage: ['MV', 'SHORTS', 'TEASER'],
        restrictedUsage: ['AD'],
        territories: ['KR', 'JP'],
        commercialUse: true,
        trainingPermitted: false,
        syntheticPermitted: true,
        startsAt: new Date('2026-01-01'),
        expiresAt: new Date('2027-12-31'),
      },
    });
  }

  // ── 더미 생성 모델 어댑터 (§12 능력 필터용 capabilities) ──
  const models = [
    {
      code: 'mock-fast',
      provider: 'SELF_HOSTED',
      endpoint: null,
      capabilities: { maxDurationMs: 15000, maxPersons: 3, modes: ['i2v', 'pose-guided'], maxResolution: 1080 },
      costPerSecond: 0.02,
      metrics: { identityScore: 0.82, motionScore: 0.7, qualityScore: 0.75, avgLatencyMs: 20000, failureRate: 0.02, regenRate: 0.3 },
    },
    {
      code: 'mock-quality',
      provider: 'EXTERNAL_API',
      endpoint: 'http://localhost:9999/mock',
      capabilities: { maxDurationMs: 30000, maxPersons: 5, modes: ['i2v', 'v2v', 'pose-guided'], maxResolution: 2160 },
      costPerSecond: 0.18,
      metrics: { identityScore: 0.91, motionScore: 0.86, qualityScore: 0.9, avgLatencyMs: 90000, failureRate: 0.03, regenRate: 0.15 },
    },
    {
      code: 'mock-multi',
      provider: 'EXTERNAL_API',
      endpoint: 'http://localhost:9999/mock',
      capabilities: { maxDurationMs: 20000, maxPersons: 8, modes: ['pose-guided', 'v2v'], maxResolution: 1080 },
      costPerSecond: 0.12,
      metrics: { identityScore: 0.87, motionScore: 0.92, qualityScore: 0.82, avgLatencyMs: 60000, failureRate: 0.05, regenRate: 0.22 },
    },
  ];
  for (const m of models) {
    await prisma.aiModel.upsert({
      where: { code: m.code },
      update: { capabilities: m.capabilities, metrics: m.metrics, costPerSecond: m.costPerSecond },
      create: m as never,
    });
  }

  // ── Higgsfield 실제 모델 (공식 OpenAPI v2.0.0 기준) ────
  // 능력값은 스펙에서 그대로 옮겼다. costPerSecond는 계약 단가가 확정되면 갱신해야 한다.
  const higgsfield = [
    {
      code: 'higgsfield-veo31-reference',
      provider: 'EXTERNAL_API',
      endpoint: '/veo3.1/reference-to-video',
      // 레퍼런스 이미지 1~3장으로 신원을 조건화한다 — CREZ Identity conditioning의 실제 경로
      capabilities: { maxDurationMs: 8000, maxPersons: 3, modes: ['reference'], maxResolution: 1080, billable: true,
                      durations: [4, 6, 8], endpoint: '/veo3.1/reference-to-video',
                      pricingSource: '미확정 — 계약 단가 확인 후 갱신' },
      costPerSecond: 0.4,
    },
    {
      code: 'higgsfield-veo31-i2v',
      provider: 'EXTERNAL_API',
      endpoint: '/veo3.1/image-to-video',
      capabilities: { maxDurationMs: 8000, maxPersons: 1, modes: ['i2v'], maxResolution: 1080, billable: true,
                      durations: [4, 6, 8], endpoint: '/veo3.1/image-to-video',
                      pricingSource: '미확정 — 계약 단가 확인 후 갱신' },
      costPerSecond: 0.3,
    },
    {
      code: 'higgsfield-kling25-pro-i2v',
      provider: 'EXTERNAL_API',
      endpoint: '/kling-video/v2.5-turbo/pro/image-to-video',
      capabilities: { maxDurationMs: 10000, maxPersons: 1, modes: ['i2v'], maxResolution: 1080, billable: true,
                      durations: [5, 10], endpoint: '/kling-video/v2.5-turbo/pro/image-to-video',
                      pricingSource: '미확정 — 계약 단가 확인 후 갱신' },
      costPerSecond: 0.25,
    },
    {
      code: 'higgsfield-sora2-i2v',
      provider: 'EXTERNAL_API',
      endpoint: '/sora-2/image-to-video',
      capabilities: { maxDurationMs: 12000, maxPersons: 1, modes: ['i2v'], maxResolution: 720, billable: true,
                      durations: [4, 8, 12], endpoint: '/sora-2/image-to-video',
                      pricingSource: '미확정 — 계약 단가 확인 후 갱신' },
      costPerSecond: 0.35,
    },
    // 2026-09-16 계정 점검에서 실제로 호출된 kling 변형들 (모델 확인 단계를 통과해 값 검증까지 도달).
    // i2v는 시작 이미지 1장이라 인물 1명만 가능하고 다중 인물 신원 조건화는 되지 않는다.
    {
      code: 'higgsfield-kling25-standard-i2v',
      provider: 'EXTERNAL_API',
      endpoint: '/kling-video/v2.5-turbo/standard/image-to-video',
      capabilities: { maxDurationMs: 10000, maxPersons: 1, modes: ['i2v'], maxResolution: 1080, billable: true,
                      durations: [5, 10], endpoint: '/kling-video/v2.5-turbo/standard/image-to-video',
                      pricingSource: '미확정 — 계약 단가 확인 후 갱신' },
      costPerSecond: 0.18,
    },
    {
      code: 'higgsfield-kling21-pro-i2v',
      provider: 'EXTERNAL_API',
      endpoint: '/kling-video/v2.1/pro/image-to-video',
      capabilities: { maxDurationMs: 10000, maxPersons: 1, modes: ['i2v'], maxResolution: 1080, billable: true,
                      durations: [5, 10], endpoint: '/kling-video/v2.1/pro/image-to-video',
                      pricingSource: '미확정 — 계약 단가 확인 후 갱신' },
      costPerSecond: 0.2,
    },
    {
      code: 'higgsfield-kling21-standard-i2v',
      provider: 'EXTERNAL_API',
      endpoint: '/kling-video/v2.1/standard/image-to-video',
      capabilities: { maxDurationMs: 10000, maxPersons: 1, modes: ['i2v'], maxResolution: 1080, billable: true,
                      durations: [5, 10], endpoint: '/kling-video/v2.1/standard/image-to-video',
                      pricingSource: '미확정 — 계약 단가 확인 후 갱신' },
      costPerSecond: 0.12,
    },
    {
      code: 'higgsfield-kling21-master-i2v',
      provider: 'EXTERNAL_API',
      endpoint: '/kling-video/v2.1/master/image-to-video',
      capabilities: { maxDurationMs: 10000, maxPersons: 1, modes: ['i2v'], maxResolution: 1080, billable: true,
                      durations: [5, 10], endpoint: '/kling-video/v2.1/master/image-to-video',
                      pricingSource: '미확정 — 계약 단가 확인 후 갱신' },
      costPerSecond: 0.3,
    },
  ];
  // 계정에서 실제로 호출되는 모델만 ACTIVE로 둔다 (2026-09-16 확인).
  // veo3.1·sora2 계열은 model_not_found·model_disabled라, 지정하면 생성이 매번 실패한다.
  // 접근이 열리면 여기에 code를 넣거나 PATCH /models/{code}/status 로 켠다.
  const HF_ACTIVE = new Set([
    'higgsfield-kling25-pro-i2v', 'higgsfield-kling25-standard-i2v',
    'higgsfield-kling21-pro-i2v', 'higgsfield-kling21-standard-i2v', 'higgsfield-kling21-master-i2v',
  ]);
  for (const m of higgsfield) {
    const status = HF_ACTIVE.has(m.code) ? 'ACTIVE' : 'DISABLED';
    await prisma.aiModel.upsert({
      where: { code: m.code },
      update: { capabilities: m.capabilities as never, endpoint: m.endpoint, costPerSecond: m.costPerSecond, status },
      create: { ...m, capabilities: m.capabilities as never, status, metrics: {} } as never,
    });
  }

  // ── §10 QC ruleset v1 — 초기 가중치는 기획 초안 제안값 ──
  // v2가 활성이므로 v1은 비활성으로 남긴다(이력 재현용).
  await prisma.qcRuleset.upsert({
    where: { version: 'qc-v1' },
    update: { isActive: false },
    create: {
      version: 'qc-v1',
      isActive: false,
      note: '기획 초안 제안 가중치 (Face 45 / Body 20 / Temporal 20 / Binding 10 / Motion 5). 실사 검증으로 qc-v2에 자리를 넘김.',
      weights: { face: 0.45, body: 0.2, temporal: 0.2, binding: 0.1, motion: 0.05 },
      thresholds: {
        perIdentityMin: 0.85,      // §20 Multi-Person 목표
        maxSpread: 0.12,           // §10.3 캐스트 간 편차 허용
        overallMin: 0.9,           // §20 Single Person 목표
        driftDropRatio: 0.12,
        driftMinDurationSec: 1.0,
        blendMargin: 0.05,
        blendMinDurationSec: 0.6,
        swapMinDurationSec: 0.8,
        flickerZScore: 2.5,
        trackLostMinDurationSec: 0.5,
        minFrameQuality: 0.35,
        assignMinSimilarity: 0.35,
      },
    },
  });

  // ── §10 QC ruleset v2 — 실사 생성 실측으로 재보정한 합격선 ──
  //
  // v1의 0.85/0.9는 mock 응답(얼굴·시간 일관성 0.93대)에 맞춰진 값이라 실제 생성물은 넘을 수 없었다.
  // 2026-09-16 kling v2.5 turbo pro 실측(5초, 캐스트 1명):
  //   · 인물이 끝까지 유지된 영상 : 얼굴 0.711 / 신체 0.761 / 시간 0.511 / binding 0.911 → 종합 0.700
  //   · 1.9초에 인물이 교체된 영상 : 얼굴 0.643 / 시간 0.386 / binding 0.372          → 종합 0.53 부근
  // 두 사례를 가르는 신호는 binding(인물이 화면에 남아 있는 비율)이며, 그 사이를 자르는 값으로 잡았다.
  //
  // 표본 2건짜리 잠정값이다. 검증셋이 쌓이면 qc-v3로 다시 올린다 — 임계값을 고칠 때는
  // 행을 새로 만들고 활성만 옮긴다(qc_run.ruleset_version으로 과거 판정을 재현해야 하므로 덮어쓰지 않는다).
  await prisma.qcRuleset.upsert({
    where: { version: 'qc-v2' },
    update: { isActive: true },
    create: {
      version: 'qc-v2',
      isActive: true,
      note: '실사 생성 2건 실측 기반 잠정 합격선 (구간 0.62 / 종합 0.65). 가중치는 v1 유지.',
      weights: { face: 0.45, body: 0.2, temporal: 0.2, binding: 0.1, motion: 0.05 },
      thresholds: {
        perIdentityMin: 0.62,
        maxSpread: 0.12,
        overallMin: 0.65,
        driftDropRatio: 0.12,
        driftMinDurationSec: 1.0,
        blendMargin: 0.05,
        blendMinDurationSec: 0.6,
        swapMinDurationSec: 0.8,
        flickerZScore: 2.5,
        trackLostMinDurationSec: 0.5,
        minFrameQuality: 0.35,
        // §9.1 τ_assign — 이 값을 넘지 못한 track은 캐스트 인물이 아니다.
        // 넘기지 않으면 화면의 다른 사람 track까지 캐스트에 묶여 지표가 망가진다.
        assignMinSimilarity: 0.35,
        // 컷 사이 같은 인물의 점수 편차 허용치. 컷마다 합격해도 이어 붙이면
        // 사람이 바뀐 것처럼 보이는 경우를 마스터 결합 직전에 막는다.
        sequenceMaxSpread: 0.15,
      },
    },
  });

  // ── §12.1 지출 한도 ────────────────────────────────────
  // 생성 한 번이 수십 건의 유료 요청이고 제출한 요청은 되돌릴 수 없다. 한도는 제출 전에 건다.
  // 크레딧 단가는 계약 정보라 시드가 알 수 없다 — 비워 두고, 채우기 전까지 유료 생성을 막는다.
  await prisma.spendPolicy.upsert({
    where: { orgId: org.id },
    update: {},
    create: { orgId: org.id, monthlyBudgetKrw: 100000 },
  });

  // ── §12 Model Router 가중치 ────────────────────────────
  await prisma.routingRuleset.upsert({
    where: { version: 'routing-v1' },
    update: {},
    create: {
      version: 'routing-v1',
      isActive: true,
      weights: { identity: 0.45, motion: 0.2, quality: 0.15, speed: 0.1, cost: 0.1 },
    },
  });

  const counts = {
    identities: await prisma.identity.count(),
    profiles: await prisma.identityProfile.count(),
    models: await prisma.aiModel.count(),
    users: await prisma.appUser.count(),
  };
  console.log('seed complete', counts);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
