/**
 * 검증용 — 외부에서 생성한 인물 이미지를 실제 임베딩과 함께 Identity로 등록한다.
 *
 * 실인물 동의 절차 없이 파이프라인을 실증하기 위한 경로다. 합성 인물을 쓰므로
 * 개인정보 이슈가 없고, 임베딩은 시드 난수가 아니라 SFace 실추론 결과를 넣는다.
 *
 * 선행: /v1/embed/face 응답의 vector를 /tmp/crez-ref-vec.json 으로 저장하고,
 *       이미지를 identities/hf-demo/ref-front.jpg 키로 업로드해 둘 것.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { insertEmbedding, setProfileCentroids } from '@crez/db';
import { readFileSync } from 'node:fs';

const prisma = new PrismaClient();

async function main() {
  const vector: number[] = JSON.parse(readFileSync('/tmp/crez-ref-vec.json', 'utf8'));
  const org = await prisma.organization.findFirstOrThrow({ where: { name: 'CREZ' } });

  // Higgsfield로 만든 합성 인물을 Identity로 등록한다 (실존 인물 동의 이슈 없음)
  const identity = await prisma.identity.upsert({
    where: { orgId_code: { orgId: org.id, code: 'CRZ-H001' } },
    update: {},
    create: { orgId: org.id, code: 'CRZ-H001', displayName: 'HF-DEMO (합성인물)', status: 'ACTIVE' },
  });

  const assetId = randomUUID();
  await prisma.identityAsset.upsert({
    where: { id: assetId },
    update: {},
    create: {
      id: assetId, identityId: identity.id, assetType: 'FACE_IMAGE', captureSlot: 'FRONT',
      storageKey: 'identities/hf-demo/ref-front.jpg', checksum: 'hf-demo',
      qualityScore: 0.7149, isUsable: true, width: 526, height: 555,
    },
  });

  // 실제 SFace 임베딩을 저장한다 — 시드 난수가 아니다
  await insertEmbedding({
    id: randomUUID(), identityId: identity.id, assetId, kind: 'FACE',
    modelName: 'sface@2021dec', modelVersion: 'onnxruntime-cpu/opencv-4.10.0',
    dim: 512, vector, quality: 0.7149,
  });

  const last = await prisma.identityProfile.findFirst({
    where: { identityId: identity.id }, orderBy: { version: 'desc' },
  });
  const profile = await prisma.identityProfile.create({
    data: {
      identityId: identity.id, version: (last?.version ?? 0) + 1, status: 'ACTIVE',
      faceVariance: 0,
      attributes: { source: 'higgsfield-generated-synthetic', assetCount: 1, seeded: false } as never,
      modelBundle: { faceEmbedder: 'sface@2021dec', detector: 'yunet@2023mar',
                     runtime: 'onnxruntime-cpu/opencv-4.10.0' } as never,
      builtAt: new Date(),
    },
  });
  await setProfileCentroids(profile.id, vector, null);

  await prisma.identityRights.create({
    data: {
      identityId: identity.id, ownerName: 'CREZ (합성 인물, 실존 인물 아님)',
      consentStatus: 'GRANTED', allowedUsage: ['MV', 'SHORTS'], restrictedUsage: [],
      territories: ['KR'], commercialUse: true, trainingPermitted: false, syntheticPermitted: true,
      startsAt: new Date('2026-01-01'),
    },
  });

  console.log(JSON.stringify({
    identityId: identity.id, code: identity.code, profileId: profile.id,
    version: profile.version,
  }));
}
main().finally(() => prisma.$disconnect());
