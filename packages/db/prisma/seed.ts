/**
 * 로컬 개발 시드 (§18): 샘플 identity 5명 + 더미 모델 어댑터.
 * 추가로 §10 점수 ruleset 초기값과 §12 라우팅 가중치를 넣는다.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { encryptField } from '../src/crypto';
import { toVectorLiteral } from '../src/vector';

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
    await prisma.$executeRawUnsafe(
      `UPDATE identity_profile SET face_centroid = $1::vector, body_centroid = $2::vector WHERE id = $3::uuid`,
      toVectorLiteral(face), toVectorLiteral(body), profile.id,
    );

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

  // ── §10 QC ruleset v1 — 초기 가중치는 기획 초안 제안값 ──
  await prisma.qcRuleset.upsert({
    where: { version: 'qc-v1' },
    update: {},
    create: {
      version: 'qc-v1',
      isActive: true,
      note: '기획 초안 제안 가중치 (Face 45 / Body 20 / Temporal 20 / Binding 10 / Motion 5). Phase 2 검증셋으로 재조정 예정.',
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
      },
    },
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
